import type { OpenVikingRuntimeState } from "../../core/openviking-memory";
import type { AppSettingsUpdate } from "../../core/platform";

/**
 * Every setting the resolved extraction route depends on. Miss one and the running extractor
 * keeps using the old route after the user changes it. The Claude summary settings are
 * deliberately absent: extraction rejects the Claude source outright, so they cannot move it.
 */
const EXTRACTION_SETTING_KEYS = new Set<keyof AppSettingsUpdate>([
  "summarySource",
  "summaryApiConfigMode",
  "summaryCodexModel",
  "summaryCodexConfigDir",
  "openVikingExtractionReasoningEffort",
  "summaryApiConfig",
]);

export function openVikingExtractionSettingsChanged(update: AppSettingsUpdate): boolean {
  return Object.keys(update).some((key) => EXTRACTION_SETTING_KEYS.has(key as keyof AppSettingsUpdate));
}

export async function restartOpenVikingForExtractionSettings(input: {
  update: AppSettingsUpdate;
  enabled: boolean;
  runtimeState: OpenVikingRuntimeState;
  stop(): Promise<unknown>;
  start(): Promise<unknown>;
}): Promise<void> {
  if (!input.enabled || !openVikingExtractionSettingsChanged(input.update)) return;
  if (input.runtimeState === "running") await input.stop();
  await input.start();
}
