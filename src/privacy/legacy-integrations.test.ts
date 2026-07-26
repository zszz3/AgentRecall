import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLegacyCleanup,
  inspectLegacyIntegrations,
  previewLegacyCleanup,
} from "./legacy-integrations";

const temporaryRoots: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `agent-recall-${label}-`));
  temporaryRoots.push(directory);
  return directory;
}

async function writeJson(filePath: string, value: unknown): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, content, "utf8");
  return content;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy integration cleanup", () => {
  it("detects MCP, hook, and status line entries without changing any config", async () => {
    const homeDir = await temporaryDirectory("legacy-inspect");
    const backupRoot = await temporaryDirectory("legacy-backup");
    const claudeConfig = path.join(homeDir, ".claude.json");
    const claudeSettings = path.join(homeDir, ".claude", "settings.json");
    const codexConfig = path.join(homeDir, ".codex", "config.toml");
    const codexHooks = path.join(homeDir, ".codex", "hooks.json");

    const originals = new Map<string, string>();
    originals.set(claudeConfig, await writeJson(claudeConfig, {
      mcpServers: {
        keep: { command: "keep-server" },
        "agent-recall": { command: "node", args: ["/opt/agent-recall-mcp.mjs"] },
      },
    }));
    originals.set(claudeSettings, await writeJson(claudeSettings, {
      theme: "dark",
      statusLine: { type: "command", command: "agent-recall-claude-statusline" },
      hooks: {
        Stop: [{
          hooks: [
            { type: "command", command: "keep-hook" },
            { type: "command", command: 'node "/opt/session-sync-record.cjs"' },
          ],
        }],
      },
    }));
    await mkdir(path.dirname(codexConfig), { recursive: true });
    const codexToml = [
      "[mcp_servers.keep]",
      'command = "keep-server"',
      "",
      "[mcp_servers.agent_recall]",
      'command = "node"',
      'args = ["/opt/agent-recall-mcp.mjs"]',
      "",
      "[profiles.work]",
      'model = "gpt-5"',
      "",
    ].join("\n");
    await writeFile(codexConfig, codexToml, "utf8");
    originals.set(codexConfig, codexToml);
    originals.set(codexHooks, await writeJson(codexHooks, {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "agent-recall-session-sync" }] },
          { hooks: [{ type: "command", command: "keep-codex-hook" }] },
        ],
      },
    }));

    const inspection = await inspectLegacyIntegrations({ homeDir });
    expect(inspection.issues).toEqual([]);
    expect(inspection.findings.map((item) => item.kind).sort()).toEqual([
      "hook",
      "hook",
      "mcp",
      "mcp",
      "statusline",
    ]);

    const plan = await previewLegacyCleanup({
      homeDir,
      backupRoot,
      now: new Date("2026-07-25T01:02:03.000Z"),
      idFactory: () => "plan-1",
    });
    expect(plan.actions).toHaveLength(4);
    expect(plan.confirmationToken).toMatch(/^remove-agent-recall-/);
    for (const [filePath, content] of originals) {
      expect(await readFile(filePath, "utf8")).toBe(content);
    }
    expect(await readdir(backupRoot)).toEqual([]);
  });

  it("requires confirmation, backs up originals, and removes only AgentRecall-owned entries", async () => {
    const homeDir = await temporaryDirectory("legacy-apply");
    const backupRoot = await temporaryDirectory("legacy-backups");
    const claudeConfig = path.join(homeDir, ".claude.json");
    const claudeSettings = path.join(homeDir, ".claude", "settings.json");
    const codexConfig = path.join(homeDir, ".codex", "config.toml");
    const originalClaudeConfig = await writeJson(claudeConfig, {
      custom: { tokenName: "preserve-structure" },
      mcpServers: {
        keep: { command: "keep-server", args: ["--safe"] },
        "agent-recall": { command: "agent-recall-mcp" },
      },
    });
    const originalClaudeSettings = await writeJson(claudeSettings, {
      statusLine: { type: "command", command: "my-statusline" },
      hooks: {
        PostToolUse: [{
          matcher: "Skill",
          hooks: [
            { type: "command", command: "keep-hook" },
            { type: "command", command: "agent-recall-skill-usage" },
          ],
        }],
      },
    });
    await mkdir(path.dirname(codexConfig), { recursive: true });
    const originalCodexConfig = [
      "[mcp_servers.agent_recall]",
      'command = "agent-recall-mcp"',
      "",
      "[mcp_servers.keep]",
      'command = "keep-server"',
      "",
    ].join("\n");
    await writeFile(codexConfig, originalCodexConfig, "utf8");

    const plan = await previewLegacyCleanup({
      homeDir,
      backupRoot,
      now: new Date("2026-07-25T01:02:03.000Z"),
      idFactory: () => "plan-2",
    });
    await expect(applyLegacyCleanup(plan, "not-confirmed")).rejects.toThrow(/confirmation token/i);
    expect(await readdir(backupRoot)).toEqual([]);
    expect(await readFile(claudeConfig, "utf8")).toBe(originalClaudeConfig);

    const result = await applyLegacyCleanup(plan, plan.confirmationToken);
    expect(result.changedFiles).toHaveLength(3);
    expect(result.backupDirectory).toBeTruthy();
    expect(path.relative(backupRoot, result.backupDirectory as string)).not.toMatch(/^\.\.(?:[/\\]|$)/);
    expect(await inspectLegacyIntegrations({ homeDir })).toMatchObject({ findings: [], issues: [] });

    const cleanedClaude = JSON.parse(await readFile(claudeConfig, "utf8"));
    expect(cleanedClaude.custom).toEqual({ tokenName: "preserve-structure" });
    expect(cleanedClaude.mcpServers).toEqual({ keep: { command: "keep-server", args: ["--safe"] } });
    const cleanedSettings = JSON.parse(await readFile(claudeSettings, "utf8"));
    expect(cleanedSettings.statusLine.command).toBe("my-statusline");
    expect(cleanedSettings.hooks.PostToolUse[0].hooks).toEqual([
      { type: "command", command: "keep-hook" },
    ]);
    expect(await readFile(codexConfig, "utf8")).toContain("[mcp_servers.keep]");
    expect(await readFile(codexConfig, "utf8")).not.toContain("[mcp_servers.agent_recall]");

    const backupDirectory = result.backupDirectory as string;
    expect(await readFile(path.join(backupDirectory, ".claude.json"), "utf8")).toBe(originalClaudeConfig);
    expect(await readFile(path.join(backupDirectory, ".claude", "settings.json"), "utf8"))
      .toBe(originalClaudeSettings);
    expect(await readFile(path.join(backupDirectory, ".codex", "config.toml"), "utf8"))
      .toBe(originalCodexConfig);
    if (process.platform !== "win32") {
      expect((await stat(backupDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(backupDirectory, ".claude.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(claudeConfig)).mode & 0o077).toBe(0);
    }
  });

  it("refuses to overwrite a config changed after preview", async () => {
    const homeDir = await temporaryDirectory("legacy-stale");
    const backupRoot = await temporaryDirectory("legacy-stale-backup");
    const configPath = path.join(homeDir, ".claude.json");
    await writeJson(configPath, {
      mcpServers: { "agent-recall": { command: "agent-recall-mcp" } },
    });
    const plan = await previewLegacyCleanup({ homeDir, backupRoot });
    await writeJson(configPath, {
      preferenceAddedLater: true,
      mcpServers: { "agent-recall": { command: "agent-recall-mcp" } },
    });

    await expect(applyLegacyCleanup(plan, plan.confirmationToken)).rejects.toThrow(/stale/i);
    expect(await readdir(backupRoot)).toEqual([]);
    expect(JSON.parse(await readFile(configPath, "utf8")).preferenceAddedLater).toBe(true);
  });

  it("rejects crafted plan IDs before constructing a backup path", async () => {
    const homeDir = await temporaryDirectory("legacy-plan-id");
    const backupRoot = await temporaryDirectory("legacy-plan-id-backup");
    await writeJson(path.join(homeDir, ".claude.json"), {
      mcpServers: { "agent-recall": { command: "agent-recall-mcp" } },
    });
    const plan = await previewLegacyCleanup({ homeDir, backupRoot });
    const crafted = { ...plan, planId: path.join("..", "..", "escaped") };

    await expect(applyLegacyCleanup(crafted, crafted.confirmationToken)).rejects.toThrow(/planId/i);
    expect(await readdir(backupRoot)).toEqual([]);
  });

  it("reports malformed configs and never rewrites them", async () => {
    const homeDir = await temporaryDirectory("legacy-invalid");
    const configPath = path.join(homeDir, ".claude.json");
    await writeFile(configPath, "{ invalid json", "utf8");

    const inspection = await inspectLegacyIntegrations({ homeDir });
    expect(inspection.findings).toEqual([]);
    expect(inspection.issues).toHaveLength(1);
    expect(await readFile(configPath, "utf8")).toBe("{ invalid json");
  });

  it.runIf(process.platform !== "win32")("refuses candidate directories that escape through symlinks", async () => {
    const homeDir = await temporaryDirectory("legacy-symlink-home");
    const outsideDir = await temporaryDirectory("legacy-symlink-outside");
    const backupRoot = await temporaryDirectory("legacy-symlink-backup");
    const outsideConfig = path.join(outsideDir, "settings.json");
    const original = await writeJson(outsideConfig, {
      hooks: {
        Stop: [{ hooks: [{ command: "agent-recall-session-sync" }] }],
      },
    });
    await symlink(outsideDir, path.join(homeDir, ".claude"), "dir");

    const inspection = await inspectLegacyIntegrations({ homeDir });
    expect(inspection.findings).toEqual([]);
    expect(inspection.issues.some((issue) => /symbolic links/i.test(issue.error))).toBe(true);
    const plan = await previewLegacyCleanup({ homeDir, backupRoot });
    expect(plan.actions).toEqual([]);
    expect(await readFile(outsideConfig, "utf8")).toBe(original);
  });

  it.runIf(process.platform !== "win32")("refuses a symlinked backup root", async () => {
    const homeDir = await temporaryDirectory("legacy-backup-link-home");
    const outsideDir = await temporaryDirectory("legacy-backup-link-outside");
    const linkParent = await temporaryDirectory("legacy-backup-link-parent");
    const backupRoot = path.join(linkParent, "backups");
    await writeJson(path.join(homeDir, ".claude.json"), {
      mcpServers: { "agent-recall": { command: "agent-recall-mcp" } },
    });
    await symlink(outsideDir, backupRoot, "dir");

    await expect(previewLegacyCleanup({ homeDir, backupRoot })).rejects.toThrow(/symbolic link/i);
    expect(await readdir(outsideDir)).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("refuses a pre-created symlink at the versioned backup directory", async () => {
    const homeDir = await temporaryDirectory("legacy-backup-dir-link-home");
    const backupRoot = await temporaryDirectory("legacy-backup-dir-link-root");
    const outsideDir = await temporaryDirectory("legacy-backup-dir-link-outside");
    const configPath = path.join(homeDir, ".claude.json");
    await writeJson(configPath, {
      mcpServers: { "agent-recall": { command: "agent-recall-mcp" } },
    });
    await chmod(configPath, 0o600);
    const plan = await previewLegacyCleanup({
      homeDir,
      backupRoot,
      now: new Date("2026-07-25T01:02:03.000Z"),
      idFactory: () => "plan-symlink",
    });
    const backupDirectory = path.join(
      backupRoot,
      "2026-07-25T01-02-03-000Z-plan-symlink",
    );
    await symlink(outsideDir, backupDirectory, "dir");

    await expect(
      applyLegacyCleanup(plan, plan.confirmationToken),
    ).rejects.toThrow();
    expect(await readdir(outsideDir)).toEqual([]);
    expect(JSON.parse(await readFile(configPath, "utf8")).mcpServers).toHaveProperty("agent-recall");
  });
});
