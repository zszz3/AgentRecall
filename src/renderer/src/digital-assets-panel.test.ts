import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const dialogSource = readFileSync(new URL("./features/digital-assets/digital-assets-dialog.tsx", import.meta.url), "utf8");
const tabSource = readFileSync(new URL("./features/digital-assets/asset-sync-tab.tsx", import.meta.url), "utf8");
const badgeSource = readFileSync(new URL("./features/digital-assets/sync-status-badge.tsx", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("digital assets panel", () => {
  it("renders rules and memories tabs", () => {
    expect(dialogSource).toContain('"rules"');
    expect(dialogSource).toContain('"memories"');
    expect(dialogSource).toContain("DigitalAssetsTab");
    expect(dialogSource).toContain("activeTab");
  });

  it("provides upload all, upload item, and delete operations for both asset types", () => {
    expect(dialogSource).toContain("onRulesUploadAll");
    expect(dialogSource).toContain("onRulesUpload");
    expect(dialogSource).toContain("onRulesDelete");
    expect(dialogSource).toContain("onMemoriesUploadAll");
    expect(dialogSource).toContain("onMemoriesUpload");
    expect(dialogSource).toContain("onMemoriesDelete");
  });

  it("provides copy setup SQL for both asset types", () => {
    expect(dialogSource).toContain("onRulesCopySql");
    expect(dialogSource).toContain("onMemoriesCopySql");
  });

  it("includes a Skills jump entry", () => {
    expect(dialogSource).toContain("onOpenSkills");
    expect(dialogSource).toContain("PackageSearch");
  });

  it("computes sync state by comparing local and remote items", () => {
    expect(tabSource).toContain("computeSyncState");
    expect(tabSource).toContain('"synced"');
    expect(tabSource).toContain('"modified"');
    expect(tabSource).toContain('"new"');
    expect(tabSource).toContain("content_hash");
    expect(tabSource).toContain("contentHash");
  });

  it("renders local and remote asset tables", () => {
    expect(tabSource).toContain("Local assets");
    expect(tabSource).toContain("Remote assets");
    expect(tabSource).toContain("asset-table");
    expect(tabSource).toContain("onDeleteRemote");
    expect(tabSource).toContain("onUploadItem");
  });

  it("renders sync status badges with all states", () => {
    expect(badgeSource).toContain("ready");
    expect(badgeSource).toContain("missing-table");
    expect(badgeSource).toContain("error");
    expect(badgeSource).toContain("unconfigured");
    expect(badgeSource).toContain("SyncStatusBadge");
    expect(badgeSource).toContain("AssetSyncIcon");
  });

  it("has dialog styles in the stylesheet", () => {
    expect(stylesheet).toContain(".digital-assets-dialog");
    expect(stylesheet).toContain(".digital-assets-tabs");
    expect(stylesheet).toContain(".digital-assets-tab.active");
    expect(stylesheet).toContain(".asset-sync-tab");
    expect(stylesheet).toContain(".asset-table");
    expect(stylesheet).toContain(".sync-badge");
    expect(stylesheet).toContain(".asset-sync-icon");
  });

  it("uses browser-safe assetIdentity for stable asset matching", () => {
    expect(dialogSource).toContain("assetIdentity");
    expect(dialogSource).not.toContain("import { ruleIdentity }");
    expect(dialogSource).not.toContain("import { memoryIdentity }");
  });
});
