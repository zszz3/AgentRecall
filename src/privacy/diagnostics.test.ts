import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectPrivacyDiagnostics,
  formatPrivacyDiagnostics,
  sanitizeDiagnosticValue,
} from "./diagnostics";

const temporaryRoots: string[] = [];

async function temporaryHome(): Promise<string> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "agent-recall-diagnostics-"));
  temporaryRoots.push(homeDir);
  return homeDir;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("privacy diagnostics", () => {
  it("reports required local health fields and legacy integrations without network work", async () => {
    const homeDir = await temporaryHome();
    const claudeConfig = path.join(homeDir, ".claude.json");
    await mkdir(path.dirname(claudeConfig), { recursive: true });
    await writeFile(claudeConfig, JSON.stringify({
      mcpServers: { "agent-recall": { command: "agent-recall-mcp" } },
    }), "utf8");

    const report = await collectPrivacyDiagnostics({
      version: "1.0.0",
      homeDir,
      platform: "darwin",
      arch: "arm64",
      osRelease: "25.0.0",
      generatedAt: new Date("2026-07-25T00:00:00.000Z"),
      data: { status: "healthy", path: path.join(homeDir, "Library", "AgentRecall") },
      database: { status: "healthy", path: path.join(homeDir, "Library", "AgentRecall", "sessions.db") },
      sources: [
        { source: "claude", count: 4 },
        { source: "codex", count: 6 },
      ],
      cli: [
        { name: "claude", available: true, version: "2.1.0", path: path.join(homeDir, "bin", "claude") },
        { name: "codex", available: false, error: "not found" },
      ],
      terminal: { selected: "Terminal", available: true, path: "/Applications/Utilities/Terminal.app" },
      update: {
        automaticChecksEnabled: false,
        status: "disabled",
        currentVersion: "1.0.0",
        lastCheckedAt: null,
      },
      pathMode: "home",
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      app: { version: "1.0.0" },
      system: { platform: "darwin", arch: "arm64", release: "25.0.0" },
      storage: { data: { status: "healthy" }, database: { status: "healthy" } },
      sessions: { total: 10 },
      update: { automaticChecksEnabled: false, status: "disabled" },
      legacyIntegrations: { findingCount: 1, issueCount: 0 },
    });
    expect(report.storage.database.path).toBe("~/Library/AgentRecall/sessions.db");
    expect(formatPrivacyDiagnostics(report)).toContain('"findingCount": 1');
  });

  it("always redacts credential keys and common inline secret formats", () => {
    const homeDir = path.join(path.sep, "Users", "example");
    const sanitized = sanitizeDiagnosticValue({
      apiKey: "sk-should-never-appear",
      nested: {
        Authorization: "Bearer should-never-appear",
        detail: [
          "token=should-never-appear",
          "https://example.test/check?access_token=should-never-appear",
          "provider sk-ant-abcdefghijk",
          path.join(homeDir, "private", "session.json"),
        ],
      },
    }, { homeDir, pathMode: "basename" });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("should-never-appear");
    expect(serialized).not.toContain("sk-ant-abcdefghijk");
    expect(serialized).not.toContain(homeDir);
    expect(serialized).toContain("<redacted>");
  });
});
