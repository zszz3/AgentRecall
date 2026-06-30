import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENT_SESSION_SEARCH_SKILLS_TABLE,
  SkillVersionConflictError,
  SupabaseSkillSyncClient,
  buildSkillSyncSetupSql,
  buildSkillVersionBasePayload,
  groupRemoteSkillVersions,
  skillSyncContentHash,
  skillSyncFingerprint,
  type RemoteSkill,
  type RemoteSkillVersion,
} from "./skill-sync";
import type { InstalledSkill } from "./skill-manager";

function localSkill(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    id: "codex-user:/tmp/.codex/skills/review-code/SKILL.md",
    name: "review-code",
    description: "Review code changes",
    agent: "codex",
    source: "codex-user",
    path: "/tmp/.codex/skills/review-code/SKILL.md",
    directoryPath: "/tmp/.codex/skills/review-code",
    rootPath: "/tmp/.codex/skills",
    markdown: "---\nname: review-code\ndescription: Review code changes\n---\n\n# Review",
    mtimeMs: 100,
    ...overrides,
  };
}

function versionRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "remote-1",
    name: "review-code",
    description: "Review code changes",
    agent: "codex",
    source: "codex-user",
    local_fingerprint: "fp",
    content_hash: "hash-1",
    uploaded_from_path: "/tmp/SKILL.md",
    version: 1,
    created_at: "2026-06-29T10:00:00.000Z",
    updated_at: "2026-06-29T10:00:00.000Z",
    ...overrides,
  };
}

function version(overrides: Partial<RemoteSkillVersion> = {}): RemoteSkillVersion {
  return {
    id: "remote-1",
    name: "review-code",
    description: "Review code changes",
    agent: "codex",
    source: "codex-user",
    localFingerprint: "fp",
    contentHash: "hash-1",
    uploadedFromPath: "/tmp/SKILL.md",
    version: 1,
    createdAt: "2026-06-29T10:00:00.000Z",
    updatedAt: "2026-06-29T10:00:00.000Z",
    ...overrides,
  };
}

describe("skill sync", () => {
  it("builds Supabase setup SQL with per-version uniqueness and content hash", () => {
    const sql = buildSkillSyncSetupSql();

    expect(sql).toContain(`create table if not exists public.${AGENT_SESSION_SEARCH_SKILLS_TABLE}`);
    expect(sql).toContain("content_hash text not null default ''");
    expect(sql).toContain(`add column if not exists content_hash`);
    expect(sql).toContain(`drop index if exists ${AGENT_SESSION_SEARCH_SKILLS_TABLE}_fingerprint_idx;`);
    expect(sql).toContain(`${AGENT_SESSION_SEARCH_SKILLS_TABLE}_fingerprint_version_idx`);
    expect(sql).toContain("(local_fingerprint, version)");
    expect(sql).toContain("enable row level security");
    expect(sql).not.toContain("service_role");
  });

  it("uses an agent and skill name fingerprint for repeat uploads across local paths", () => {
    const expected = createHash("sha256").update("codex:review-code").digest("hex");

    expect(skillSyncFingerprint(localSkill({ path: "/a/SKILL.md" }))).toBe(expected);
    expect(skillSyncFingerprint(localSkill({ path: "/b/SKILL.md" }))).toBe(expected);
    expect(skillSyncFingerprint(localSkill({ agent: "claude" }))).not.toBe(expected);
  });

  it("computes a content hash that is stable for identical content and changes with content", () => {
    const files = [{ relativePath: "references/a.md", contentBase64: Buffer.from("a").toString("base64"), mode: 0o644 }];
    const base = skillSyncContentHash("# Body", files);

    expect(skillSyncContentHash("# Body", files)).toBe(base);
    expect(skillSyncContentHash("# Body changed", files)).not.toBe(base);
    expect(skillSyncContentHash("# Body", [{ ...files[0], contentBase64: Buffer.from("b").toString("base64") }])).not.toBe(base);
  });

  it("groups remote versions by fingerprint and exposes the latest version", () => {
    const groups = groupRemoteSkillVersions([
      version({ id: "a-v1", localFingerprint: "fp-a", version: 1, updatedAt: "2026-06-01T00:00:00.000Z" }),
      version({ id: "a-v3", localFingerprint: "fp-a", version: 3, updatedAt: "2026-06-03T00:00:00.000Z" }),
      version({ id: "a-v2", localFingerprint: "fp-a", version: 2, updatedAt: "2026-06-02T00:00:00.000Z" }),
      version({ id: "b-v1", localFingerprint: "fp-b", name: "other", version: 1, updatedAt: "2026-06-10T00:00:00.000Z" }),
    ]);

    expect(groups.map((group) => group.fingerprint)).toEqual(["fp-b", "fp-a"]);
    const groupA = groups.find((group) => group.fingerprint === "fp-a");
    expect(groupA?.latest.id).toBe("a-v3");
    expect(groupA?.versions.map((item) => item.version)).toEqual([3, 2, 1]);
  });

  it("reports missing-table status when Supabase has not been initialized", async () => {
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async () => new Response(JSON.stringify({ code: "PGRST205", message: "Could not find the table" }), { status: 404 }),
    });

    const status = await client.checkStatus();

    expect(status.kind).toBe("missing-table");
    expect(status.setupSql).toContain(AGENT_SESSION_SEARCH_SKILLS_TABLE);
  });

  it("lists remote skill versions with lightweight columns", async () => {
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co/",
      anonKey: "anon",
      fetchImpl: async (url) => {
        expect(String(url)).toContain(`/rest/v1/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?select=`);
        expect(String(url)).toContain("content_hash");
        expect(String(url)).not.toContain("markdown");
        expect(String(url)).toContain("order=local_fingerprint.asc,version.desc");
        return new Response(JSON.stringify([versionRow({ version: 2, content_hash: "hash-2" })]), { status: 200 });
      },
    });

    await expect(client.listRemoteSkillVersions()).resolves.toEqual([version({ version: 2, contentHash: "hash-2" })]);
  });

  it("fetches the latest version for a fingerprint", async () => {
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url) => {
        expect(String(url)).toContain("local_fingerprint=eq.fp");
        expect(String(url)).toContain("order=version.desc&limit=1");
        return new Response(JSON.stringify([versionRow({ version: 4, content_hash: "hash-4" })]), { status: 200 });
      },
    });

    await expect(client.getLatestSkillVersion("fp")).resolves.toEqual(version({ version: 4, contentHash: "hash-4" }));
  });

  it("returns null when no version exists yet for a fingerprint", async () => {
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async () => new Response(JSON.stringify([]), { status: 200 }),
    });

    await expect(client.getLatestSkillVersion("fp")).resolves.toBeNull();
  });

  it("inserts a new skill version with its content hash and version number", async () => {
    const { base, contentHash } = buildSkillVersionBasePayload(localSkill());
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(`https://example.supabase.co/rest/v1/${AGENT_SESSION_SEARCH_SKILLS_TABLE}`);
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).Prefer).toBe("return=representation");
        const body = JSON.parse(String(init?.body));
        expect(body.version).toBe(2);
        expect(body.content_hash).toBe(contentHash);
        return new Response(JSON.stringify([{ ...body, id: "remote-9", created_at: "2026-06-29T10:00:00.000Z", updated_at: "2026-06-29T10:05:00.000Z" }]), { status: 201 });
      },
    });

    const result = await client.insertSkillVersion(base, 2);
    expect(result).toMatchObject({ id: "remote-9", version: 2, contentHash, markdown: localSkill().markdown });
  });

  it("retries a version insert with a fresh number after a unique conflict", async () => {
    const { base } = buildSkillVersionBasePayload(localSkill());
    const calls: Array<{ method: string; version?: number }> = [];
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init?.body));
          calls.push({ method: "POST", version: body.version });
          if (body.version === 2) return new Response(JSON.stringify({ code: "23505", message: "duplicate key" }), { status: 409 });
          return new Response(JSON.stringify([{ ...body, id: "remote-3", created_at: "x", updated_at: "y" }]), { status: 201 });
        }
        calls.push({ method: "GET" });
        return new Response(JSON.stringify([versionRow({ version: 2 })]), { status: 200 });
      },
    });

    const result = await client.uploadSkillVersion(base, 2);
    expect(result.version).toBe(3);
    expect(calls).toEqual([
      { method: "POST", version: 2 },
      { method: "GET" },
      { method: "POST", version: 3 },
    ]);
  });

  it("surfaces a SkillVersionConflictError directly from insertSkillVersion", async () => {
    const { base } = buildSkillVersionBasePayload(localSkill());
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async () => new Response(JSON.stringify({ code: "23505" }), { status: 409 }),
    });

    await expect(client.insertSkillVersion(base, 5)).rejects.toBeInstanceOf(SkillVersionConflictError);
  });

  it("fetches one full remote skill version by id before installing it locally", async () => {
    const remote: RemoteSkill = {
      ...version(),
      markdown: "# Review",
      metadata: { skillFiles: [] },
    };
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url) => {
        expect(String(url)).toBe(`https://example.supabase.co/rest/v1/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?id=eq.remote-1&select=*&limit=1`);
        return new Response(JSON.stringify([versionRow({ markdown: "# Review", metadata: { skillFiles: [] } })]), { status: 200 });
      },
    });

    await expect(client.getRemoteSkill("remote-1")).resolves.toEqual(remote);
  });

  it("includes the full skill directory and content hash in the upload payload", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skill-sync-files-"));
    const skillDir = path.join(homeDir, ".codex", "skills", "review-code");
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
    fs.writeFileSync(skillPath, "# Review\n", "utf8");
    fs.writeFileSync(path.join(skillDir, "references", "rubric.md"), "Check edge cases.\n", "utf8");
    const uploaded = localSkill({ path: skillPath, directoryPath: skillDir, rootPath: path.dirname(skillDir), markdown: "# Review\n" });

    const { base, contentHash } = buildSkillVersionBasePayload(uploaded);

    expect(base.content_hash).toBe(contentHash);
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
    const skillFiles = (base.metadata as { skillFiles: Array<{ relativePath: string; contentBase64: string }> }).skillFiles;
    expect(skillFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "SKILL.md", contentBase64: Buffer.from("# Review\n").toString("base64") }),
        expect.objectContaining({ relativePath: "references/rubric.md", contentBase64: Buffer.from("Check edge cases.\n").toString("base64") }),
      ]),
    );

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("aborts a slow Supabase request with a timeout instead of hanging forever", async () => {
    let receivedSignal: AbortSignal | undefined;
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      timeoutMs: 50,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    });

    await expect(client.checkStatus()).rejects.toThrow(/timed out/i);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});
