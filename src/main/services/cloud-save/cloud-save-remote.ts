import type {
  CommitSnapshotRequest,
  GameShop,
  PrepareSnapshotRequest,
} from "@types";

import { HydraApi } from "../hydra-api";
import { SupabaseCloud } from "../supabase-cloud";
import { buildDeleteGameCloudSaveSnapshotsUrl } from "./delete-game-cloud-save-data-policy";

const subscriptionOptions = {
  needsAuth: true,
  needsSubscription: true,
} as const;

/** Keeps the V2 cloud-save workflow independent of its remote backend. */
export class CloudSaveRemote {
  static usesSupabase() {
    return SupabaseCloud.isConfigured();
  }

  static prepareSnapshot(request: PrepareSnapshotRequest) {
    return this.usesSupabase()
      ? SupabaseCloud.prepareSnapshot(request)
      : HydraApi.post<unknown>(
          "/profile/cloud-saves/prepare-snapshot",
          request,
          subscriptionOptions
        );
  }

  static commitSnapshot(request: CommitSnapshotRequest) {
    return this.usesSupabase()
      ? SupabaseCloud.commitSnapshot(request.pendingSnapshotId)
      : HydraApi.post<unknown>(
          "/profile/cloud-saves/commit-snapshot",
          request,
          subscriptionOptions
        );
  }

  static listSnapshots(shop: GameShop, objectId: string) {
    return this.usesSupabase()
      ? SupabaseCloud.listSnapshots(shop, objectId)
      : HydraApi.get<unknown>(
          "/profile/cloud-saves/snapshots",
          { shop, objectId },
          subscriptionOptions
        );
  }

  static getSnapshotManifest(snapshotId: string) {
    return this.usesSupabase()
      ? SupabaseCloud.getSnapshotManifest(snapshotId)
      : HydraApi.get<unknown>(
          "/profile/cloud-saves/snapshot-restore-manifest",
          { snapshotId },
          subscriptionOptions
        );
  }

  static getSnapshotDownloadUrls(snapshotId: string) {
    return this.usesSupabase()
      ? SupabaseCloud.getSnapshotDownloadUrls(snapshotId)
      : HydraApi.get<unknown>(
          "/profile/cloud-saves/snapshot-download-urls",
          { snapshotId },
          subscriptionOptions
        );
  }

  static deleteSnapshots(shop: GameShop, objectId: string) {
    return this.usesSupabase()
      ? SupabaseCloud.deleteSnapshots(shop, objectId)
      : HydraApi.delete<void>(
          buildDeleteGameCloudSaveSnapshotsUrl(objectId, shop),
          subscriptionOptions
        );
  }
}
