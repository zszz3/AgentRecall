import { describe, expect, it } from "vitest";
import { detectLiveSessionsFromProcessLines } from "./session-activity";

describe("live session detection", () => {
  it("detects Codex, Claude, and CodeBuddy resume commands without matching unrelated commands", () => {
    expect(
      detectLiveSessionsFromProcessLines([
        "123 /opt/homebrew/bin/codex resume codex-1",
        '124 /opt/homebrew/bin/codex resume "codex two"',
        "125 /opt/homebrew/bin/claude --resume claude-1",
        "126 /opt/homebrew/bin/claude --resume=claude-2",
        "127 /Users/xjx/.codebuddy/bin/codebuddy --resume codebuddy-1",
        "128 rg codex resume ignored",
      ]),
    ).toEqual([
      { family: "codex", rawId: "codex-1", pid: 123 },
      { family: "codex", rawId: "codex two", pid: 124 },
      { family: "claude", rawId: "claude-1", pid: 125 },
      { family: "claude", rawId: "claude-2", pid: 126 },
      { family: "codebuddy", rawId: "codebuddy-1", pid: 127 },
    ]);
  });
});
