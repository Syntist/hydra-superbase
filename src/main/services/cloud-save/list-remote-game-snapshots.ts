import type { GameShop, RemoteSnapshotSummary } from "@types";

import { validateRemoteSnapshotSummary } from "./cloud-save-contract";
import { CloudSaveRemote } from "./cloud-save-remote";

const validateRemoteSnapshots = (value: unknown): RemoteSnapshotSummary[] => {
  if (!Array.isArray(value)) throw new Error("Invalid snapshots response");
  if (value.length > 1) {
    throw new Error("Cloud Save API returned more than one active snapshot");
  }
  return value.map(validateRemoteSnapshotSummary);
};

export const listRemoteGameSnapshots = async (
  objectId: string,
  shop: GameShop
) =>
  validateRemoteSnapshots(await CloudSaveRemote.listSnapshots(shop, objectId));
