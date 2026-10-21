import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import vm from "node:vm";
import { it } from "node:test";
import ts from "typescript";
import { SupabaseSession } from "./supabase-session.ts";
import { mapWithConcurrency } from "./cloud-save/map-with-concurrency.ts";

const hash = crypto.createHash("sha256").update("save").digest("hex");
const file = {
  variantId: "v",
  rawPath: "<home>/saves",
  relativePath: "save.dat",
  hash,
  sizeBytes: 4,
  lastModifiedAt: 1,
};

async function fixture(
  options: {
    exists?: boolean;
    storageError?: boolean;
    activeVersion?: number;
  } = {}
) {
  const rows: Record<string, unknown>[] = [];
  const queries: unknown[][] = [];
  const uploads: unknown[][] = [];
  const bucket = {
    list: async () =>
      options.storageError
        ? { data: null, error: new Error("storage unavailable") }
        : {
            data: options.exists ? [{ name: hash, metadata: { size: 4 } }] : [],
            error: null,
          },
    upload: async (...args: unknown[]) => {
      uploads.push(args);
      return { error: null };
    },
    createSignedUrl: async () => ({
      data: { signedUrl: "https://storage.test/download" },
      error: null,
    }),
  };
  const client = {
    auth: {
      setSession: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
    },
    storage: { from: () => bucket },
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: (...args: unknown[]) => {
          queries.push([table, ...args]);
          return query;
        },
        maybeSingle: async () => ({
          data: options.activeVersion
            ? {
                version: options.activeVersion,
                logical_id: "logical",
                created_at: "2026-01-01",
              }
            : null,
          error: null,
        }),
        single: async () => ({
          data: {
            logical_id: "logical",
            version: 1,
            shop: "steam",
            object_id: "game",
            files: [file],
            variants: [],
            custom_path_raw_paths: [],
          },
          error: null,
        }),
        insert: async (row: Record<string, unknown>) => {
          rows.push(row);
          return { error: null };
        },
      };
      return query;
    },
    rpc: async () => ({
      data: [
        {
          snapshot_id: "logical",
          snapshot_version: 2,
          snapshot_file_count: 1,
          snapshot_total_size_bytes: 4,
          snapshot_aggregate_hash: hash,
        },
      ],
      error: null,
    }),
  };
  const source = fs
    .readFileSync(new URL("./supabase-cloud.ts", import.meta.url), "utf8")
    .replaceAll(
      "import.meta.env",
      '({ MAIN_VITE_SUPABASE_URL: "https://test", MAIN_VITE_SUPABASE_ANON_KEY: "key" })'
    );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const exports: Record<string, any> = {};
  vm.runInNewContext(output, {
    exports,
    Buffer,
    AbortSignal,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        access_token: "access",
        refresh_token: "refresh",
        user: { id: "owner" },
      }),
    }),
    require: (name: string) => {
      if (name === "@supabase/supabase-js")
        return { createClient: () => client };
      if (name === "node:fs")
        return { promises: { readFile: async () => Buffer.from("save") } };
      if (name === "node:crypto") return crypto;
      if (name === "./supabase-session") return { SupabaseSession };
      if (name === "./cloud-save/map-with-concurrency")
        return { mapWithConcurrency };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const cloud = exports.SupabaseCloud;
  await cloud.authenticateWithHydraToken("token");
  const request = {
    shop: "steam",
    objectId: "game",
    snapshotHash: hash,
    baseVersion: options.activeVersion ?? 0,
    files: [file],
    variants: [],
    customPathRawPaths: [],
  };
  return { cloud, rows, queries, uploads, request };
}

it("prepares new files for upload and commits the logical snapshot", async () => {
  const { cloud, rows, request } = await fixture();
  const prepared = await cloud.prepareSnapshot(request);
  assert.equal(prepared.files[0].status, "upload");
  assert.equal(rows[0].user_id, "owner");
  assert.equal(rows[0].version, 1);
  const committed = await cloud.commitSnapshot(prepared.pendingSnapshotId);
  assert.equal(committed.snapshotId, "logical");
  assert.equal(committed.version, 2);
});

it("skips existing blobs when publishing metadata-only custom-path changes", async () => {
  const { cloud, rows, request } = await fixture({
    exists: true,
    activeVersion: 3,
  });
  const prepared = await cloud.prepareSnapshot(request);
  assert.equal(prepared.files[0].status, "skip");
  assert.equal(rows[0].logical_id, "logical");
  assert.equal(rows[0].version, 4);
  assert.equal(rows[0].created_at, "2026-01-01");
});

it("rejects stale base versions before creating a pending snapshot", async () => {
  const { cloud, rows, request } = await fixture({ activeVersion: 3 });
  await assert.rejects(
    cloud.prepareSnapshot({ ...request, baseVersion: 2 }),
    /cloud_save_snapshot_version_conflict/
  );
  assert.equal(rows.length, 0);
});

it("propagates storage lookup failures without claiming a file can be skipped", async () => {
  const { cloud, request } = await fixture({ storageError: true });
  await assert.rejects(cloud.prepareSnapshot(request), /storage unavailable/);
});

it("verifies local bytes before uploading and refuses changed saves", async () => {
  const { cloud, uploads } = await fixture();
  await cloud.uploadSnapshotBlob("save.dat", hash);
  assert.equal(uploads[0][0], `owner/v2/${hash}`);
  await assert.rejects(
    cloud.uploadSnapshotBlob("save.dat", "0".repeat(64)),
    /cloud_save_local_state_changed/
  );
  assert.equal(uploads.length, 1);
});

it("restores the active logical snapshot with owner-scoped download URLs", async () => {
  const { cloud, queries } = await fixture();
  const manifest = await cloud.getSnapshotManifest("logical");
  const urls = await cloud.getSnapshotDownloadUrls("logical");
  assert.equal(manifest.snapshot.id, "logical");
  assert.equal(urls[0].downloadUrl, "https://storage.test/download");
  assert.ok(
    queries.some((entry) => entry[1] === "user_id" && entry[2] === "owner")
  );
  await cloud.signOut();
  await assert.rejects(
    cloud.getSnapshotManifest("logical"),
    /not authenticated/
  );
});
