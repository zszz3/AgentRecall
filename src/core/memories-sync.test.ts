import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  buildMemoriesSyncSetupSql,
  memoryIdentity,
  scanLocalMemories,
  SupabaseMemoriesSyncClient,
  type AgentMemory,
} from "./memories-sync";

const require = createRequire(import.meta.url);

describe("memories sync", () => {
  it("scans Qoder global and project memories across user-id directories", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "memories-sync-scan-"));

    // Global memory
    const globalDir = path.join(homeDir, ".qoder", "memories", "user-abc", "global", "user_info");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, "my-account.md"), "---\ntitle: Account\n---\nMy GitHub account.", "utf8");

    // Project memory
    const projectDir = path.join(homeDir, ".qoder", "memories", "user-abc", "projects", "d-my-app", "tool_experience");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "git-push-tip.md"), "---\ntitle: Git Push\n---\nAlways clear token.", "utf8");

    const memories = scanLocalMemories({ homeDir });

    expect(memories).toHaveLength(2);

    const global = memories.find((m) => m.scope === "global");
    expect(global).toMatchObject({
      agent: "qoder",
      scope: "global",
      name: "user_info/my-account.md",
      category: "user_info",
      projectPath: "",
    });
    expect(global!.content).toContain("My GitHub account.");

    const project = memories.find((m) => m.scope === "project");
    expect(project).toMatchObject({
      agent: "qoder",
      scope: "project",
      name: "tool_experience/git-push-tip.md",
      category: "tool_experience",
      projectPath: "d-my-app",
    });

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("skips empty memory files", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "memories-sync-empty-"));
    const dir = path.join(homeDir, ".qoder", "memories", "uid", "global", "user_info");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "empty.md"), "   \n  ", "utf8");

    const memories = scanLocalMemories({ homeDir });
    expect(memories).toHaveLength(0);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns empty array when .qoder/memories does not exist", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "memories-sync-none-"));
    const memories = scanLocalMemories({ homeDir });
    expect(memories).toHaveLength(0);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("generates stable identity ignoring user-id layer", () => {
    const global: AgentMemory = {
      agent: "qoder", scope: "global", name: "user_info/account.md", category: "user_info",
      content: "x", contentHash: "h", projectPath: "", filePath: "/a/b/c.md",
    };
    const project: AgentMemory = {
      agent: "qoder", scope: "project", name: "tool_experience/git.md", category: "tool_experience",
      content: "x", contentHash: "h", projectPath: "d-my-app", filePath: "/a/b/d.md",
    };
    expect(memoryIdentity(global)).toBe("qoder:global:user_info/account.md");
    expect(memoryIdentity(project)).toBe("qoder:project:d-my-app:tool_experience/git.md");
  });

  it("builds setup SQL with table, unique index, RLS, and grants", () => {
    const sql = buildMemoriesSyncSetupSql();
    expect(sql).toContain("create table if not exists public.agent_recall_memories");
    expect(sql).toContain("agent in ('qoder', 'codex')");
    expect(sql).toContain("create unique index if not exists agent_recall_memories_identity_idx");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("grant select, insert, update, delete on table public.agent_recall_memories to anon");
  });

  it("uploads a memory via Supabase REST with upsert", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const mockFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify([{
        id: "mem-1", agent: "qoder", scope: "global", name: "user_info/account.md",
        category: "user_info", content: "test", content_hash: "abc", project_path: "",
        version: 1, created_at: "2026-01-01", updated_at: "2026-01-01",
      }]), { status: 201 });
    };

    const client = new SupabaseMemoriesSyncClient({ url: "https://test.supabase.co", anonKey: "key", fetchImpl: mockFetch });
    const result = await client.uploadMemory({
      agent: "qoder", scope: "global", name: "user_info/account.md", category: "user_info",
      content: "test", contentHash: "abc", projectPath: "", filePath: "/x.md",
    });

    expect(result.id).toBe("mem-1");
    expect(capturedUrl).toContain("/rest/v1/agent_recall_memories?on_conflict=agent,scope,name,project_path");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Prefer"]).toContain("resolution=merge-duplicates");
  });

  it("lists remote memories ordered by updated_at", async () => {
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([
      { id: "m1", agent: "qoder", scope: "global", name: "a/b.md", category: "a", content: "x", content_hash: "h", project_path: "", version: 1, created_at: "t", updated_at: "t2" },
      { id: "m2", agent: "qoder", scope: "project", name: "c/d.md", category: "c", content: "y", content_hash: "h2", project_path: "proj", version: 2, created_at: "t", updated_at: "t1" },
    ]), { status: 200 });

    const client = new SupabaseMemoriesSyncClient({ url: "https://test.supabase.co", anonKey: "key", fetchImpl: mockFetch });
    const list = await client.listRemoteMemories();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("m1");
    expect(list[1].scope).toBe("project");
  });

  it("reports missing-table status when Supabase returns 404", async () => {
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify({ message: "relation does not exist" }), { status: 404 });
    const client = new SupabaseMemoriesSyncClient({ url: "https://test.supabase.co", anonKey: "key", fetchImpl: mockFetch });
    const status = await client.checkStatus();
    expect(status.kind).toBe("missing-table");
    expect(status.remediation).toBe("sql");
  });

  it("scans Codex memories from stage1_outputs SQLite table", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "memories-sync-codex-"));
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const dbPath = path.join(codexDir, "memories_1.sqlite");

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE stage1_outputs (
      thread_id TEXT PRIMARY KEY,
      source_updated_at INTEGER NOT NULL,
      raw_memory TEXT NOT NULL,
      rollout_summary TEXT NOT NULL,
      rollout_slug TEXT,
      generated_at INTEGER NOT NULL,
      usage_count INTEGER,
      last_usage INTEGER,
      selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
      selected_for_phase2_source_updated_at INTEGER
    )`);
    db.prepare("INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("thread-001", 1000, "User prefers TypeScript over JavaScript.", "Discussion about language preference.", "ts-preference", 1720000000);
    db.prepare("INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("thread-002", 2000, "   ", "Empty memory should be skipped.", null, 1720000100);
    db.close();

    const memories = scanLocalMemories({ homeDir });

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      agent: "codex",
      scope: "global",
      name: "ts-preference",
      category: "stage1",
      projectPath: "",
    });
    expect(memories[0].content).toBe("User prefers TypeScript over JavaScript.");

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("gracefully skips when Codex database does not exist", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "memories-sync-nocodex-"));
    const memories = scanLocalMemories({ homeDir });
    expect(memories).toHaveLength(0);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});
