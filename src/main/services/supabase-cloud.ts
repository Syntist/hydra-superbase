import { SupabaseSession } from "./supabase-session";
import { mapWithConcurrency } from "./cloud-save/map-with-concurrency";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import crypto from "node:crypto";
import type {
  CommitSnapshotResponse,
  GameShop,
  PrepareSnapshotRequest,
  PrepareSnapshotResponse,
  RemoteSnapshotSummary,
  RestoreDownloadUrlFile,
  RestoreManifestResponse,
  SnapshotFile,
  UnlockedAchievement,
} from "@types";

const url = import.meta.env.MAIN_VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.MAIN_VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;
let supabase: SupabaseClient | null = null;
const sessionState = new SupabaseSession();
const getClient = () => {
  if (!url || !anonKey) return null;
  return (supabase ??= createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  }));
};

const getUserId = () => {
  if (!sessionState.userId) {
    throw new Error("Supabase Cloud user is not authenticated");
  }
  return sessionState.userId;
};

export class SupabaseCloud {
  static isConfigured() {
    return !!getClient();
  }

  static isAuthenticated() {
    return sessionState.userId !== null;
  }

  static async authenticateWithHydraToken(hydraAccessToken: string) {
    const client = getClient();
    if (!client || !url || !anonKey || !hydraAccessToken) return false;
    return sessionState.authenticate(hydraAccessToken, async () => {
      const response = await fetch(`${url}/functions/v1/hydra-auth-bridge`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${hydraAccessToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Supabase Hydra auth bridge failed (${response.status})${detail ? `: ${detail}` : ""}`
        );
      }
      const session = (await response.json()) as Partial<{
        access_token: string;
        refresh_token: string;
        user: { id: string };
      }>;
      if (
        !session.access_token ||
        !session.refresh_token ||
        !session.user?.id
      ) {
        throw new Error(
          "Supabase Hydra auth bridge returned an invalid session"
        );
      }
      return {
        userId: session.user.id,
        apply: async () => {
          const { error } = await client.auth.setSession({
            access_token: session.access_token!,
            refresh_token: session.refresh_token!,
          });
          if (error) throw error;
        },
      };
    });
  }

  static async signOut() {
    return sessionState.signOut(async () => {
      const result = await getClient()?.auth.signOut({ scope: "local" });
      if (result?.error) throw result.error;
    });
  }

  static async syncAchievements(
    shop: GameShop,
    objectId: string,
    achievements: UnlockedAchievement[]
  ) {
    const client = getClient();
    if (!client) return;
    const userId = getUserId();
    const { error } = await client.from("hydra_achievement_sync").upsert(
      {
        user_id: userId,
        shop,
        object_id: objectId,
        achievements,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,shop,object_id" }
    );
    if (error) throw error;
  }

  static async prepareSnapshot(
    request: PrepareSnapshotRequest
  ): Promise<PrepareSnapshotResponse> {
    const client = getClient();
    if (!client) throw new Error("Supabase is not configured");
    const owner = getUserId();
    const { data: active, error: activeError } = await client
      .from("hydra_cloud_snapshots")
      .select("logical_id,version,created_at")
      .eq("user_id", owner)
      .eq("shop", request.shop)
      .eq("object_id", request.objectId)
      .eq("status", "active")
      .maybeSingle();
    if (activeError) throw activeError;
    if ((active?.version ?? 0) !== request.baseVersion) {
      throw new Error("cloud_save_snapshot_version_conflict");
    }

    const pendingSnapshotId = crypto.randomUUID();
    const logicalId = active?.logical_id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const { error } = await client.from("hydra_cloud_snapshots").insert({
      id: pendingSnapshotId,
      logical_id: logicalId,
      user_id: owner,
      shop: request.shop,
      object_id: request.objectId,
      version: request.baseVersion + 1,
      status: "pending",
      aggregate_hash: request.snapshotHash,
      file_count: request.files.length,
      total_size_bytes: request.files.reduce(
        (total, file) => total + file.sizeBytes,
        0
      ),
      custom_path_raw_paths: request.customPathRawPaths,
      variants: request.variants,
      files: request.files,
      created_at: active?.created_at ?? now,
      updated_at: now,
    });
    if (error) throw error;

    const files = await mapWithConcurrency(request.files, 8, async (file) => {
      const { data, error } = await client.storage
        .from("hydra-cloud-v2")
        .list(`${owner}/v2`, { search: file.hash, limit: 1 });
      if (error) throw error;
      if (
        data.some(
          (entry) =>
            entry.name === file.hash && entry.metadata?.size === file.sizeBytes
        )
      ) {
        return {
          variantId: file.variantId,
          rawPath: file.rawPath,
          relativePath: file.relativePath,
          status: "skip" as const,
        };
      }
      return {
        variantId: file.variantId,
        rawPath: file.rawPath,
        relativePath: file.relativePath,
        status: "upload" as const,
        uploadUrl: `https://supabase.invalid/${file.hash}`,
        requiredHeaders: {
          "Content-Length": String(file.sizeBytes),
          "x-amz-checksum-sha256": Buffer.from(file.hash, "hex").toString(
            "base64"
          ),
        },
      };
    });
    return { pendingSnapshotId, snapshotHash: request.snapshotHash, files };
  }

  static async uploadSnapshotBlob(sourcePath: string, hash: string) {
    const client = getClient();
    if (!client) throw new Error("Supabase is not configured");
    const storagePath = `${getUserId()}/v2/${hash}`;
    const body = await fs.promises.readFile(sourcePath);
    if (crypto.createHash("sha256").update(body).digest("hex") !== hash) {
      throw new Error("cloud_save_local_state_changed");
    }
    const { error } = await client.storage
      .from("hydra-cloud-v2")
      .upload(storagePath, body, {
        contentType: "application/octet-stream",
        upsert: true,
      });
    if (error) throw error;
  }

  static async commitSnapshot(
    pendingSnapshotId: string
  ): Promise<CommitSnapshotResponse> {
    const client = getClient();
    if (!client) throw new Error("Supabase is not configured");
    const { data, error } = await client.rpc("hydra_commit_cloud_snapshot", {
      pending_id: pendingSnapshotId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("Pending Cloud Save snapshot not found");
    return {
      snapshotId: row.snapshot_id,
      version: row.snapshot_version,
      fileCount: row.snapshot_file_count,
      totalSizeBytes: row.snapshot_total_size_bytes,
      aggregateHash: row.snapshot_aggregate_hash,
    };
  }

  static async listSnapshots(
    shop: GameShop,
    objectId: string
  ): Promise<RemoteSnapshotSummary[]> {
    const client = getClient();
    if (!client) return [];
    const { data, error } = await client
      .from("hydra_cloud_snapshots")
      .select(
        "logical_id,version,created_at,updated_at,file_count,total_size_bytes,aggregate_hash"
      )
      .eq("user_id", getUserId())
      .eq("shop", shop)
      .eq("object_id", objectId)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw error;
    return data
      ? [
          {
            id: data.logical_id,
            version: data.version,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
            fileCount: data.file_count,
            totalSizeBytes: data.total_size_bytes,
            aggregateHash: data.aggregate_hash,
          },
        ]
      : [];
  }

  private static async getSnapshotRow(snapshotId: string) {
    const client = getClient();
    if (!client) throw new Error("Supabase is not configured");
    const { data, error } = await client
      .from("hydra_cloud_snapshots")
      .select("*")
      .eq("user_id", getUserId())
      .eq("logical_id", snapshotId)
      .eq("status", "active")
      .single();
    if (error) throw error;
    return data;
  }

  static async getSnapshotManifest(
    snapshotId: string
  ): Promise<RestoreManifestResponse> {
    const row = await this.getSnapshotRow(snapshotId);
    return {
      snapshot: {
        id: row.logical_id,
        version: row.version,
        shop: row.shop,
        objectId: row.object_id,
      },
      customPathRawPaths: row.custom_path_raw_paths ?? [],
      variants: row.variants ?? [],
      files: row.files ?? [],
    };
  }

  static async getSnapshotDownloadUrls(
    snapshotId: string
  ): Promise<RestoreDownloadUrlFile[]> {
    const client = getClient();
    if (!client) throw new Error("Supabase is not configured");
    const row = await this.getSnapshotRow(snapshotId);
    return Promise.all(
      (row.files as SnapshotFile[]).map(async (file) => {
        const storagePath = `${getUserId()}/v2/${file.hash}`;
        const { data, error } = await client.storage
          .from("hydra-cloud-v2")
          .createSignedUrl(storagePath, 60 * 60);
        if (error) throw error;
        return { ...file, downloadUrl: data.signedUrl };
      })
    );
  }

  static async deleteSnapshots(shop: GameShop, objectId: string) {
    const client = getClient();
    if (!client) throw new Error("Supabase is not configured");
    const { error } = await client
      .from("hydra_cloud_snapshots")
      .delete()
      .eq("user_id", getUserId())
      .eq("shop", shop)
      .eq("object_id", objectId);
    if (error) throw error;
  }
}
