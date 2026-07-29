import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface HookSetupOptions {
  homeDir?: string;
  settingsPath?: string;
  scriptPath?: string;
  nodePath?: string;
}
interface HookSetupModule {
  installSkillUsageHook(options: HookSetupOptions): { status: string; detail?: string };
  uninstallSkillUsageHook(options: HookSetupOptions): { status: string; detail?: string };
  skillUsageHookStatus(options: HookSetupOptions): { installed: boolean };
}

const require = createRequire(import.meta.url);
const setup = require(path.resolve("bin", "setup-skill-usage-hook.cjs")) as HookSetupModule;
const record = require(path.resolve("bin", "skill-usage-record.cjs")) as {
  buildRecord(input: unknown): Record<string, unknown> | null;
  skillMarkdownHash(skill: string, cwd: string): string;
};

function freshHome(): string {
  const homeDir = path.join(tmpdir(), `skill-usage-hook-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  return homeDir;
}

function settingsPathFor(homeDir: string): string {
  return path.join(homeDir, ".claude", "settings.json");
}

describe("skill usage hook setup", () => {
  it("merges the hook into existing settings without dropping other keys", () => {
    const homeDir = freshHome();
    const settingsPath = settingsPathFor(homeDir);
    writeFileSync(settingsPath, `${JSON.stringify({ theme: "dark", hooks: { SessionStart: [{ matcher: "startup", hooks: [] }] } }, null, 2)}\n`, "utf8");
    try {
      const result = setup.installSkillUsageHook({ homeDir, scriptPath: "/opt/app/bin/skill-usage-record.cjs" });
      expect(result.status).toBe("installed");

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settings.theme).toBe("dark");
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.PostToolUse).toEqual([
        { matcher: "Skill", hooks: [{ type: "command", command: 'node "/opt/app/bin/skill-usage-record.cjs"', async: true }] },
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("is idempotent and reports already-installed", () => {
    const homeDir = freshHome();
    try {
      const first = setup.installSkillUsageHook({ homeDir, scriptPath: "/opt/app/bin/skill-usage-record.cjs" });
      expect(first.status).toBe("installed");
      const second = setup.installSkillUsageHook({ homeDir, scriptPath: "/opt/app/bin/skill-usage-record.cjs" });
      expect(second.status).toBe("already");

      const settings = JSON.parse(readFileSync(settingsPathFor(homeDir), "utf8"));
      expect(settings.hooks.PostToolUse).toHaveLength(1);
      expect(setup.skillUsageHookStatus({ homeDir }).installed).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uninstalls our hook while preserving foreign PostToolUse hooks", () => {
    const homeDir = freshHome();
    const settingsPath = settingsPathFor(homeDir);
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier" }] }] } }, null, 2)}\n`,
      "utf8",
    );
    try {
      setup.installSkillUsageHook({ homeDir, scriptPath: "/opt/app/bin/skill-usage-record.cjs" });
      const removed = setup.uninstallSkillUsageHook({ homeDir });
      expect(removed.status).toBe("removed");

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settings.hooks.PostToolUse).toEqual([{ matcher: "Write", hooks: [{ type: "command", command: "prettier" }] }]);
      expect(setup.skillUsageHookStatus({ homeDir }).installed).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("drops the hooks object entirely when removing the only hook", () => {
    const homeDir = freshHome();
    try {
      setup.installSkillUsageHook({ homeDir, scriptPath: "/opt/app/bin/skill-usage-record.cjs" });
      setup.uninstallSkillUsageHook({ homeDir });
      const settings = JSON.parse(readFileSync(settingsPathFor(homeDir), "utf8"));
      expect(settings.hooks).toBeUndefined();
      expect(setup.uninstallSkillUsageHook({ homeDir }).status).toBe("absent");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("skill usage record payload", () => {
  it("captures session linkage fields from the PostToolUse payload", () => {
    const built = record.buildRecord({
      tool_name: "Skill",
      hook_event_name: "PostToolUse",
      tool_input: { skill: "review" },
      session_id: " abc-123 ",
      cwd: "/repo",
    });
    expect(built).toMatchObject({
      skill: "review",
      agent: "claude",
      session_id: "abc-123",
      cwd: "/repo",
    });
  });

  it("omits linkage fields when the payload does not provide usable values", () => {
    const built = record.buildRecord({
      tool_name: "Skill",
      tool_input: { skill: "review" },
      session_id: 7,
      cwd: "   ",
    });
    expect(built).toMatchObject({ skill: "review", agent: "claude" });
    expect(built).not.toHaveProperty("session_id");
    expect(built).not.toHaveProperty("cwd");
  });

  it("still ignores non-Skill tools", () => {
    expect(record.buildRecord({
      tool_name: "Bash",
      tool_input: { skill: "review" },
      session_id: "abc-123",
    })).toBeNull();
  });
});

describe("skill markdown hash capture", () => {
  afterEach(() => {
    delete process.env.AGENT_RECALL_TEST_HOME;
  });

  function writeSkill(root: string, skill: string, body: string): string {
    const dir = path.join(root, ".claude", "skills", skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
    return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
  }

  it("prefers the project-level SKILL.md over the user-level one", () => {
    const homeDir = freshHome();
    const projectDir = path.join(homeDir, "repo");
    try {
      process.env.AGENT_RECALL_TEST_HOME = homeDir;
      writeSkill(homeDir, "review", "# user copy\n");
      const projectHash = writeSkill(projectDir, "review", "# project copy\n");

      const built = record.buildRecord({
        tool_name: "Skill",
        tool_input: { skill: "review" },
        session_id: "abc",
        cwd: projectDir,
      });
      expect(built).toMatchObject({ skill: "review", skill_hash: projectHash });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back to the user-level SKILL.md and omits the field when missing", () => {
    const homeDir = freshHome();
    try {
      process.env.AGENT_RECALL_TEST_HOME = homeDir;
      const userHash = writeSkill(homeDir, "review", "# user copy\n");

      expect(record.skillMarkdownHash("review", path.join(homeDir, "elsewhere"))).toBe(userHash);
      expect(record.skillMarkdownHash("missing-skill", "")).toBe("");
      // Path-traversal shaped names must never touch the filesystem.
      expect(record.skillMarkdownHash("../evil", "")).toBe("");

      const built = record.buildRecord({
        tool_name: "Skill",
        tool_input: { skill: "missing-skill" },
        cwd: homeDir,
      });
      expect(built).toMatchObject({ skill: "missing-skill" });
      expect(built).not.toHaveProperty("skill_hash");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
