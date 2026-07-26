import { describe, expect, it } from "vitest";
import { sanitizeNativeUpdateStateForRenderer } from "./core-native-update-service";

describe("Core native update adapter", () => {
  it("does not expose the absolute database backup path to the Renderer", () => {
    expect(sanitizeNativeUpdateStateForRenderer({
      phase: "installing",
      currentVersion: "1.0.0",
      targetVersion: "1.0.1",
      progressPercent: 100,
      backupPath: "/Users/private/Library/Application Support/AgentRecall/update-backups/private",
      failure: null,
    })).toMatchObject({
      phase: "installing",
      backupPath: "<app-data>/update-backups",
    });
  });
});
