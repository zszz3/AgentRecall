import { describe, expect, it } from "vitest";
import { loadLiveSessionSnapshot } from "./session-activity";

describe("live session deletion guards", () => {
  it("guards unresolved Windows CLI families", async () => {
    const snapshot = await loadLiveSessionSnapshot({
      platform: "win32",
      runner: async () => [
        '321 "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe"',
        '322 "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"',
      ].join("\n"),
    });

    expect(snapshot.sessions).toEqual([
      { family: "claude", rawId: "*", pid: 321 },
      { family: "codex", rawId: "*", pid: 322 },
    ]);
  });
});
