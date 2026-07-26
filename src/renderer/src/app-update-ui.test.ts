import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("./core-experience-api.ts", import.meta.url), "utf8");

describe("native update and privacy UI", () => {
  it("keeps native update checks and downloads user controlled", () => {
    expect(appSource).toContain(".getNativeUpdateState()");
    expect(appSource).toContain("api.checkNativeUpdate");
    expect(appSource).toContain("api.downloadNativeUpdate");
    expect(appSource).toContain("api.installNativeUpdate");
    expect(appSource).toContain("api.retryNativeUpdate");
    expect(appSource).toContain("api.copyNativeUpdateDiagnostics");
    expect(appSource).toContain("api.openNativeUpdateHelp");
    expect(appSource).toContain("api.openNativeUpdateReleases");
    expect(appSource).not.toContain("getAppUpdateStatus");
    expect(appSource).not.toContain("installAppUpdate");
    expect(appSource).not.toContain("setInterval");
  });

  it("exposes only retained-plan privacy actions to the Renderer", () => {
    expect(appSource).toContain("api.getPrivacyDiagnostics()");
    expect(appSource).toContain("api.previewLegacyCleanup()");
    expect(appSource).toContain("window.confirm");
    expect(appSource).toContain("api.applyLegacyCleanup(cleanupPreview.planId, true)");
    expect(appSource).not.toContain("confirmationToken");
    expect(appSource).not.toContain("backupRoot");
    expect(apiSource).not.toContain("LegacyCleanupPlan");
    expect(apiSource).not.toContain("applyLegacyCleanup(");
  });

  it("keeps native update and privacy methods inside the formal Core subset", () => {
    for (const method of [
      "getNativeUpdateState",
      "checkNativeUpdate",
      "downloadNativeUpdate",
      "installNativeUpdate",
      "getPrivacyDiagnostics",
      "previewLegacyCleanup",
      "applyLegacyCleanup",
    ]) {
      expect(apiSource).toContain(`| "${method}"`);
    }
  });
});
