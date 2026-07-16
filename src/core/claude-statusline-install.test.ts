import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { installClaudeStatuslineBridge } = require("../../bin/install-claude-statusline.cjs") as {
  installClaudeStatuslineBridge: (options: {
    homeDir?: string;
    scriptPath?: string;
    settingsPath?: string;
    nodePath?: string;
  }) => { status: string; settingsPath: string; command?: string; existingCommand?: string; detail?: string };
};

const SCRIPT = "/opt/app/bin/claude-statusline-snapshot.cjs";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "session-search-bridge-"));
}

function writeSettings(homeDir: string, value: unknown): string {
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(value, null, 2), "utf8");
  return settingsPath;
}

function readSettings(settingsPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
}

describe("installClaudeStatuslineBridge", () => {
  it("writes the statusLine command into a fresh settings.json", () => {
    const homeDir = makeHome();
    try {
      const result = installClaudeStatuslineBridge({ homeDir, scriptPath: SCRIPT });

      expect(result.status).toBe("installed");
      expect(result.command).toContain(SCRIPT);
      const settings = readSettings(result.settingsPath);
      expect(settings.statusLine).toMatchObject({ type: "command" });
      expect((settings.statusLine as { command: string }).command).toContain(SCRIPT);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("preserves other settings keys when installing", () => {
    const homeDir = makeHome();
    try {
      const settingsPath = writeSettings(homeDir, { theme: "dark", permissions: { allow: ["Bash"] } });
      const result = installClaudeStatuslineBridge({ homeDir, scriptPath: SCRIPT });

      expect(result.status).toBe("installed");
      const settings = readSettings(settingsPath);
      expect(settings.theme).toBe("dark");
      expect(settings.permissions).toEqual({ allow: ["Bash"] });
      expect(settings.statusLine).toBeDefined();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("is idempotent when our bridge is already configured", () => {
    const homeDir = makeHome();
    try {
      const settingsPath = writeSettings(homeDir, {
        statusLine: { type: "command", command: `node "${SCRIPT}"` },
      });
      const before = readFileSync(settingsPath, "utf8");

      const result = installClaudeStatuslineBridge({ homeDir, scriptPath: SCRIPT });

      expect(result.status).toBe("already");
      expect(readFileSync(settingsPath, "utf8")).toBe(before);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("recognizes the global bin name as already installed", () => {
    const homeDir = makeHome();
    try {
      writeSettings(homeDir, {
        statusLine: { type: "command", command: "agent-recall-claude-statusline" },
      });
      const result = installClaudeStatuslineBridge({ homeDir, scriptPath: SCRIPT });
      expect(result.status).toBe("already");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite a user's existing statusLine", () => {
    const homeDir = makeHome();
    try {
      const settingsPath = writeSettings(homeDir, {
        statusLine: { type: "command", command: "my-custom-statusline.sh" },
      });
      const before = readFileSync(settingsPath, "utf8");

      const result = installClaudeStatuslineBridge({ homeDir, scriptPath: SCRIPT });

      expect(result.status).toBe("conflict");
      expect(result.existingCommand).toBe("my-custom-statusline.sh");
      expect(readFileSync(settingsPath, "utf8")).toBe(before);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reports an error for malformed settings.json", () => {
    const homeDir = makeHome();
    try {
      const settingsPath = path.join(homeDir, ".claude", "settings.json");
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, "{ not json", "utf8");

      const result = installClaudeStatuslineBridge({ homeDir, scriptPath: SCRIPT });

      expect(result.status).toBe("error");
      expect(result.detail).toBeTruthy();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
