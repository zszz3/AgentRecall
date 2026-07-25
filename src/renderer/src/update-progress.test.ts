import { describe, expect, it } from "vitest";
import type { AppUpdateProgress } from "../../core/app-update-types";
import { updateProgressView } from "./update-progress";

function progress(
  phase: AppUpdateProgress["phase"],
  values: Partial<AppUpdateProgress> = {},
): AppUpdateProgress {
  return { phase, version: "0.32.0", ...values };
}

describe("update progress view", () => {
  it("shows real package download percentage and speed", () => {
    expect(updateProgressView(progress("downloading", {
      percent: 50,
      bytesPerSecond: 2 * 1024 * 1024,
    }), 0)).toMatchObject({
      percent: 30,
      title: "正在下载更新",
      detail: "已下载 50% · 2.0 MB/s",
    });
  });

  it("simulates npm staging progress without reaching completion", () => {
    expect(updateProgressView(progress("staging"), 0).percent).toBe(65);
    expect(updateProgressView(progress("staging"), 60_000).percent).toBeGreaterThan(65);
    expect(updateProgressView(progress("staging"), 120_000).percent).toBe(90);
    expect(updateProgressView(progress("staging"), 600_000).percent).toBe(90);
  });

  it("uses fixed milestones for validation, restart, and completion", () => {
    expect(updateProgressView(progress("validating"), 0)).toMatchObject({
      percent: 94,
      title: "正在验证应用",
    });
    expect(updateProgressView(progress("restarting"), 0)).toMatchObject({
      percent: 98,
      title: "正在重新启动",
    });
    expect(updateProgressView(progress("completed"), 0)).toMatchObject({
      percent: 100,
      title: "更新完成",
    });
  });

  it("preserves the latest percentage when an error occurs", () => {
    expect(updateProgressView(progress("error", { error: "network failed" }), 0, 72)).toMatchObject({
      percent: 72,
      title: "更新未完成",
      detail: "network failed",
      failed: true,
    });
  });
});
