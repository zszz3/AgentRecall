import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRulesSyncSetupSql,
  restoreGlobalRules,
  ruleIdentity,
  scanLocalRules,
  SupabaseRulesSyncClient,
  type AgentRule,
  type RemoteRule,
} from "./rules-sync";

describe("rules sync", () => {
  it("scans Claude global CLAUDE.md and Qoder project rules", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-sync-scan-"));
    const projectDir = path.join(homeDir, "my-project");

    // Claude global CLAUDE.md
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "CLAUDE.md"), "# Global Rules\nUse Chinese.", "utf8");

    // Project-level CLAUDE.md
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "CLAUDE.md"), "# Project Rules", "utf8");

    // Qoder project rules
    const qoderRulesDir = path.join(projectDir, ".qoder", "rules");
    fs.mkdirSync(qoderRulesDir, { recursive: true });
    fs.writeFileSync(path.join(qoderRulesDir, "lunzi.md"), "---\ntrigger: always_on\n---\nNo reinventing wheels.", "utf8");

    const rules = scanLocalRules({ homeDir, projectDirs: [projectDir] });

    expect(rules).toHaveLength(3);

    const claudeGlobal = rules.find((r) => r.agent === "claude" && r.scope === "global");
    expect(claudeGlobal).toMatchObject({ name: "CLAUDE.md", projectPath: "", content: "# Global Rules\nUse Chinese." });
    expect(claudeGlobal!.contentHash).toHaveLength(64);

    const claudeProject = rules.find((r) => r.agent === "claude" && r.scope === "project");
    expect(claudeProject).toMatchObject({ name: "CLAUDE.md", projectPath: "my-project" });

    const qoderRule = rules.find((r) => r.agent === "qoder");
    expect(qoderRule).toMatchObject({ name: "lunzi.md", scope: "project", projectPath: "my-project" });
    expect(qoderRule!.content).toContain("trigger: always_on");

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("skips missing or empty rule files", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-sync-empty-"));
    const projectDir = path.join(homeDir, "empty-project");
    fs.mkdirSync(path.join(projectDir, ".qoder", "rules"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".qoder", "rules", "empty.md"), "", "utf8");

    const rules = scanLocalRules({ homeDir, projectDirs: [projectDir] });
    expect(rules).toHaveLength(0);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("builds rule identity from agent, scope, name, and project path", () => {
    expect(ruleIdentity({ agent: "claude", scope: "global", name: "CLAUDE.md", projectPath: "" })).toBe("claude:global:CLAUDE.md");
    expect(ruleIdentity({ agent: "qoder", scope: "project", name: "lunzi.md", projectPath: "my-app" })).toBe("qoder:project:my-app:lunzi.md");
  });

  it("builds setup SQL with table, unique index, and RLS", () => {
    const sql = buildRulesSyncSetupSql();
    expect(sql).toContain("create table if not exists public.agent_recall_rules");
    expect(sql).toContain("agent in ('claude', 'qoder')");
    expect(sql).toContain("scope in ('global', 'project')");
    expect(sql).toContain("agent_recall_rules_identity_idx");
    expect(sql).toContain("(agent, scope, name, project_path)");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("grant select, insert, update, delete");
  });

  it("uploads a rule via Supabase REST with upsert", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new SupabaseRulesSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (init?.method === "POST") {
          return new Response(JSON.stringify([{ ...JSON.parse(String(init.body)), id: "remote-1", version: 1, created_at: "x", updated_at: "y" }]), { status: 201 });
        }
        return new Response("[]", { status: 200 });
      },
    });

    const rule: AgentRule = {
      agent: "qoder", scope: "project", name: "lunzi.md", content: "rules", contentHash: "abc",
      projectPath: "my-app", filePath: "/tmp/lunzi.md",
    };
    const result = await client.uploadRule(rule);

    expect(result.id).toBe("remote-1");
    expect(calls[0].url).toContain("on_conflict=agent,scope,name,project_path");
    expect(calls[0].method).toBe("POST");
  });

  it("lists remote rules and filters invalid rows", async () => {
    const client = new SupabaseRulesSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            { id: "r1", agent: "claude", scope: "global", name: "CLAUDE.md", content: "rules", content_hash: "h", project_path: "", version: 1, created_at: "x", updated_at: "y" },
            { id: "r2", agent: "qoder" }, // invalid — missing fields
          ]),
          { status: 200 },
        ),
    });

    const rules = await client.listRemoteRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("r1");
  });

  it("checks status and reports missing table", async () => {
    const client = new SupabaseRulesSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async () => new Response(JSON.stringify({ message: 'relation "public.agent_recall_rules" does not exist' }), { status: 404 }),
    });

    const status = await client.checkStatus();
    expect(status.kind).toBe("missing-table");
    expect(status.remediation).toBe("sql");
  });

  function makeRemoteRule(overrides: Partial<RemoteRule> = {}): RemoteRule {
    return {
      id: "r1", agent: "claude", scope: "global", name: "CLAUDE.md",
      content: "# Restored Rules", content_hash: "", project_path: "",
      version: 1, created_at: "t", updated_at: "t", ...overrides,
    };
  }

  it("restores a global rule when the local file does not exist", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-restore-new-"));
    const result = restoreGlobalRules([makeRemoteRule()], { homeDir });
    expect(result.restored).toEqual(["CLAUDE.md"]);
    expect(result.skipped).toEqual([]);
    expect(result.backedUp).toEqual([]);
    expect(fs.readFileSync(path.join(homeDir, ".claude", "CLAUDE.md"), "utf8")).toBe("# Restored Rules");
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("skips a global rule when local content is identical", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-restore-skip-"));
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), "# Restored Rules", "utf8");
    const hash = require("node:crypto").createHash("sha256").update("# Restored Rules").digest("hex");
    const result = restoreGlobalRules([makeRemoteRule({ content_hash: hash })], { homeDir });
    expect(result.skipped).toEqual(["CLAUDE.md"]);
    expect(result.restored).toEqual([]);
    expect(fs.existsSync(path.join(claudeDir, "CLAUDE.md.bak"))).toBe(false);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("backs up and overwrites when local content differs", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-restore-backup-"));
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), "# Old local content", "utf8");
    const result = restoreGlobalRules([makeRemoteRule()], { homeDir });
    expect(result.restored).toEqual(["CLAUDE.md"]);
    expect(result.backedUp).toEqual(["CLAUDE.md"]);
    expect(fs.readFileSync(path.join(claudeDir, "CLAUDE.md"), "utf8")).toBe("# Restored Rules");
    expect(fs.readFileSync(path.join(claudeDir, "CLAUDE.md.bak"), "utf8")).toBe("# Old local content");
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("skips project-scope rules and unknown agents", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-restore-skip2-"));
    const result = restoreGlobalRules([
      makeRemoteRule({ scope: "project", project_path: "my-app" }),
      makeRemoteRule({ agent: "qoder", name: "some-rule.md" }),
    ], { homeDir });
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.backedUp).toEqual([]);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});
