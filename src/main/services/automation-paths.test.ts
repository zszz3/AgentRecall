import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAutomationPaths } from "./automation-paths";

describe("resolveAutomationPaths", () => {
  it("keeps automation data separate on macOS-style paths", () => {
    expect(resolveAutomationPaths("/tmp/AgentRecall", path.posix)).toEqual({
      databasePath: "/tmp/AgentRecall/automation.db",
      channelsPath: "/tmp/AgentRecall/runtime-channels.json",
      discoveryPath: "/tmp/AgentRecall/automation-mcp-bridge.json",
      bundledSkillsPath: "/tmp/AgentRecall/automation-skills",
    });
  });

  it("uses native separators for Windows user-data paths", () => {
    expect(resolveAutomationPaths("C:\\Users\\dev\\AppData\\Roaming\\AgentRecall", path.win32)).toEqual({
      databasePath: "C:\\Users\\dev\\AppData\\Roaming\\AgentRecall\\automation.db",
      channelsPath: "C:\\Users\\dev\\AppData\\Roaming\\AgentRecall\\runtime-channels.json",
      discoveryPath: "C:\\Users\\dev\\AppData\\Roaming\\AgentRecall\\automation-mcp-bridge.json",
      bundledSkillsPath: "C:\\Users\\dev\\AppData\\Roaming\\AgentRecall\\automation-skills",
    });
  });
});
