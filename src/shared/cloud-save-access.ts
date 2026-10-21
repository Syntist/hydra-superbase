export type CloudSaveAccessAction = "sign-in" | "paywall" | "open";

export const getCloudSaveAccessAction = (
  isAuthenticated: boolean,
  hasActiveSubscription: boolean,
  hasAlternativeBackend = false
): CloudSaveAccessAction => {
  if (!isAuthenticated) return "sign-in";
  if (hasAlternativeBackend) return "open";
  if (!hasActiveSubscription) return "paywall";
  return "open";
};
