import { describe, expect, it } from "vitest";

import type { AppSettingsUpdate } from "../../core/platform";
import {
  restartOpenVikingForExtractionSettings,
  restartRunningOpenVikingForPathSettings,
} from "./openviking-settings-lifecycle";

describe("restartOpenVikingForExtractionSettings", () => {
  it.each<AppSettingsUpdate>([
    { summarySource: "codex" },
    { openVikingExtractionReasoningEffort: "high" },
    { summaryApiConfig: { customModel: "deepseek-chat" } },
  ])("stops a running service before starting it for extraction update %j", async (update) => {
    const calls: string[] = [];

    await restartOpenVikingForExtractionSettings({
      update,
      enabled: true,
      runtimeState: "running",
      stop: async () => { calls.push("stop"); },
      start: async () => { calls.push("start"); },
    });

    expect(calls).toEqual(["stop", "start"]);
  });

  it("starts a stopped service without stopping it first", async () => {
    const calls: string[] = [];

    await restartOpenVikingForExtractionSettings({
      update: { summaryApiConfig: { customModel: "deepseek-chat" } },
      enabled: true,
      runtimeState: "stopped",
      stop: async () => { calls.push("stop"); },
      start: async () => { calls.push("start"); },
    });

    expect(calls).toEqual(["start"]);
  });

  it("does nothing for hook-only changes or when Memory is disabled", async () => {
    const calls: string[] = [];
    const run = (update: AppSettingsUpdate, enabled: boolean) =>
      restartOpenVikingForExtractionSettings({
        update,
        enabled,
        runtimeState: "running",
        stop: async () => { calls.push("stop"); },
        start: async () => { calls.push("start"); },
      });

    await run({ openVikingCodexEnabled: true }, true);
    await run({ openVikingExtractionModel: "gpt-5.6-sol" }, true);
    await run({ openVikingExtractionModel: "gpt-5.6-sol" }, false);

    expect(calls).toEqual([]);
  });

  it("restarts a running or errored service for path changes", async () => {
    const calls: string[] = [];
    const run = (runtimeState: "running" | "stopped" | "error", enabled: boolean) =>
      restartRunningOpenVikingForPathSettings({
        enabled,
        runtimeState,
        stop: async () => { calls.push("stop"); },
        start: async () => { calls.push("start"); },
      });

    await run("running", true);
    await run("stopped", true);
    await run("error", true);
    await run("running", false);

    expect(calls).toEqual(["stop", "start", "stop", "start"]);
  });

  it("waits for an in-flight start before restarting with the saved paths", async () => {
    const calls: string[] = [];
    let startAttempt = 0;

    await restartRunningOpenVikingForPathSettings({
      enabled: true,
      runtimeState: "starting",
      stop: async () => { calls.push("stop"); },
      start: async () => {
        startAttempt += 1;
        calls.push("start");
        if (startAttempt === 1) throw new Error("old start failed");
      },
    });

    expect(calls).toEqual(["start", "stop", "start"]);
  });
});
