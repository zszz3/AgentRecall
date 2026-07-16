import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve("bin", "claude-statusline-snapshot.cjs");

describe("Claude statusline snapshot bridge", () => {
  it("writes a minimal quota snapshot from Claude Code statusline input", () => {
    const outputPath = path.join(tmpdir(), `claude-statusline-${process.pid}-${Date.now()}.json`);
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
        input: JSON.stringify({
          plan: "max",
          cwd: "/should/not/be/persisted",
          session_id: "session-should-not-be-persisted",
          rate_limits: {
            five_hour: { used_percentage: 12.4, resets_at: 1_807_000_000 },
            seven_day: { remaining_percentage: 70, resets_at: 1_807_400_000 },
          },
        }),
        env: {
          ...process.env,
          AGENT_RECALL_CLAUDE_STATUSLINE: outputPath,
        },
        encoding: "utf8",
      });

      const snapshot = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
      expect(stdout).toContain("5h 88% left");
      expect(snapshot).toMatchObject({
        source: "agent-recall-statusline",
        plan: "max",
        rate_limits: {
          five_hour: { used_percentage: 12.4, resets_at: 1_807_000_000 },
          seven_day: { remaining_percentage: 70, resets_at: 1_807_400_000 },
        },
      });
      expect(snapshot).not.toHaveProperty("cwd");
      expect(snapshot).not.toHaveProperty("session_id");
    } finally {
      rmSync(outputPath, { force: true });
    }
  });

  it("carries forward the last known quota when a render omits rate_limits", () => {
    const outputPath = path.join(tmpdir(), `claude-statusline-${process.pid}-${Date.now()}-carry.json`);
    const run = (input: unknown): void => {
      execFileSync(process.execPath, [SCRIPT_PATH], {
        input: JSON.stringify(input),
        env: { ...process.env, AGENT_RECALL_CLAUDE_STATUSLINE: outputPath },
        encoding: "utf8",
      });
    };
    try {
      // First render carries quota data.
      run({
        plan: "max",
        rate_limits: {
          five_hour: { used_percentage: 6, resets_at: 1_807_000_000 },
          seven_day: { used_percentage: 4, resets_at: 1_807_400_000 },
        },
      });
      // A later render omits rate_limits/plan entirely (Claude Code does this intermittently).
      run({ session_id: "s", model: { id: "opus" } });

      const snapshot = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
      expect(snapshot).toMatchObject({
        plan: "max",
        rate_limits: {
          five_hour: { used_percentage: 6, resets_at: 1_807_000_000 },
          seven_day: { used_percentage: 4, resets_at: 1_807_400_000 },
        },
      });
    } finally {
      rmSync(outputPath, { force: true });
    }
  });

  it("keeps the last known percentage when a render sends a window without one", () => {
    const outputPath = path.join(tmpdir(), `claude-statusline-${process.pid}-${Date.now()}-partial.json`);
    const run = (input: unknown): void => {
      execFileSync(process.execPath, [SCRIPT_PATH], {
        input: JSON.stringify(input),
        env: { ...process.env, AGENT_RECALL_CLAUDE_STATUSLINE: outputPath },
        encoding: "utf8",
      });
    };
    try {
      // Full quota data captured first.
      run({
        plan: "max",
        rate_limits: {
          five_hour: { used_percentage: 26, resets_at: 1_807_000_000 },
          seven_day: { used_percentage: 36, resets_at: 1_807_400_000 },
        },
      });
      // A bypass-permissions render reports the windows but omits the usage percentages.
      // The percentage-less window must not erase the last known value.
      run({
        rate_limits: {
          five_hour: { resets_at: 1_807_999_999 },
          seven_day: {},
        },
      });

      const snapshot = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
      expect(snapshot).toMatchObject({
        rate_limits: {
          five_hour: { used_percentage: 26 },
          seven_day: { used_percentage: 36 },
        },
      });
    } finally {
      rmSync(outputPath, { force: true });
    }
  });
});
