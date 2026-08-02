import type { OpenVikingRuntimeState } from "../../core/openviking-memory";
import type { AppSettingsUpdate } from "../../core/platform";

const EXTRACTION_SETTING_KEYS = new Set<keyof AppSettingsUpdate>([
  "summarySource",
  "summaryCodexModel",
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

export async function restartRunningOpenVikingForPathSettings(input: {
  enabled: boolean;
  runtimeState: OpenVikingRuntimeState;
  stop(): Promise<unknown>;
  start(): Promise<unknown>;
}): Promise<void> {
  if (!input.enabled || !["running", "starting"].includes(input.runtimeState)) return;
  if (input.runtimeState === "starting") {
    try {
      await input.start();
    } catch {
      // The replacement start below uses the newly saved paths.
    }
  }
  await input.stop();
  await input.start();
}
