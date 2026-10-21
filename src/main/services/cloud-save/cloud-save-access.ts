import {
  getCloudSaveAccessAction,
  SubscriptionRequiredError,
  UserNotLoggedInError,
} from "@shared";

import { HydraApi } from "../hydra-api";
import { SupabaseCloud } from "../supabase-cloud";

export const canAccessCloudSaves = (
  isLoggedIn: boolean,
  hasActiveSubscription: boolean
) =>
  getCloudSaveAccessAction(
    isLoggedIn,
    hasActiveSubscription,
    SupabaseCloud.isConfigured()
  ) === "open";

export const assertCloudSaveSubscription = (
  isLoggedIn = HydraApi.isLoggedIn(),
  hasActiveSubscription = HydraApi.hasActiveSubscription()
) => {
  if (!isLoggedIn) {
    throw new UserNotLoggedInError();
  }
  if (SupabaseCloud.isConfigured()) return;
  if (!hasActiveSubscription) {
    throw new SubscriptionRequiredError();
  }
};
