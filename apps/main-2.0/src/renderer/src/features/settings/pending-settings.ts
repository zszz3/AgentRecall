import type { AppSettingsUpdate } from "../../../../core/platform";

/**
 * Removes a finished save from the optimistic overlay. A key stays pending when the user changed it again while
 * the save was in flight, so the older save completing does not revert the control to a stale value.
 */
export function settlePendingSettings(pending: AppSettingsUpdate, submitted: AppSettingsUpdate): AppSettingsUpdate {
  const remaining = { ...pending };
  for (const key of Object.keys(submitted) as Array<keyof AppSettingsUpdate>) {
    if (remaining[key] === submitted[key]) delete remaining[key];
  }
  return remaining;
}
