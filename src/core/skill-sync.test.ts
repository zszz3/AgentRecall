import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  AGENT_SESSION_SEARCH_SKILLS_TABLE,
  SupabaseSkillSyncClient,
  buildSkillSyncSetupSql,
  skillSyncFingerprint,
  type RemoteSkill,
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

function remoteSkill(overrides: Partial<RemoteSkill> = {}): RemoteSkill {
  return {
    id: "remote-1",
    name: "review-code",
    description: "Review code changes",
    agent: "codex",
    source: "codex-user",
    markdown: "# Review",
    localFingerprint: skillSyncFingerprint(localSkill()),
    uploadedFromPath: "/tmp/.codex/skills/review-code/SKILL.md",
    createdAt: "2026-06-29T10:00:00.000Z",
    updatedAt: "2026-06-29T10:00:00.000Z",
    version: 1,
    metadata: {},
    ...overrides,
  };
}

describe("skill sync", () => {
  it("builds Supabase setup SQL for the expected personal skills table", () => {
    const sql = buildSkillSyncSetupSql();

    expect(sql).toContain(`create table if not exists public.${AGENT_SESSION_SEARCH_SKILLS_TABLE}`);
    expect(sql).toContain("local_fingerprint text not null");
    expect(sql).toContain(`create unique index if not exists ${AGENT_SESSION_SEARCH_SKILLS_TABLE}_fingerprint_idx`);
    expect(sql).toContain(`alter table public.${AGENT_SESSION_SEARCH_SKILLS_TABLE} enable row level security`);
    expect(sql).toContain("create policy \"agent_session_search_skills_personal_sync\"");
    expect(sql).not.toContain("service_role");
  });

  it("uses an agent and skill name fingerprint for repeat uploads across local paths", () => {
    const expected = createHash("sha256").update("codex:review-code").digest("hex");

    expect(skillSyncFingerprint(localSkill({ path: "/a/SKILL.md" }))).toBe(expected);
    expect(skillSyncFingerprint(localSkill({ path: "/b/SKILL.md" }))).toBe(expected);
    expect(skillSyncFingerprint(localSkill({ agent: "claude" }))).not.toBe(expected);
  });

  it("reports missing-table status when Supabase has not been initialized", async () => {
    const fetchCalls: string[] = [];
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url) => {
        fetchCalls.push(String(url));
        return new Response(JSON.stringify({ code: "PGRST205", message: "Could not find the table" }), { status: 404 });
      },
    });

    const status = await client.checkStatus();

    expect(fetchCalls[0]).toContain(`/rest/v1/${AGENT_SESSION_SEARCH_SKILLS_TABLE}`);
    expect(status.kind).toBe("missing-table");
    expect(status.setupSql).toContain(AGENT_SESSION_SEARCH_SKILLS_TABLE);
  });

  it("lists remote skills through Supabase REST", async () => {
    const rows = [
      {
        id: "remote-1",
        name: "review-code",
        description: "Review code changes",
        agent: "codex",
        source: "codex-user",
        markdown: "# Review",
        local_fingerprint: "fp",
        uploaded_from_path: "/tmp/SKILL.md",
        created_at: "2026-06-29T10:00:00.000Z",
        updated_at: "2026-06-29T10:01:00.000Z",
        version: 2,
        metadata: { syncedBy: "test" },
      },
    ];
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co/",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(`https://example.supabase.co/rest/v1/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?select=*&order=updated_at.desc`);
        expect((init?.headers as Record<string, string>).apikey).toBe("anon");
        return new Response(JSON.stringify(rows), { status: 200 });
      },
    });

    await expect(client.listRemoteSkills()).resolves.toEqual([
      {
        id: "remote-1",
        name: "review-code",
        description: "Review code changes",
        agent: "codex",
        source: "codex-user",
        markdown: "# Review",
        localFingerprint: "fp",
        uploadedFromPath: "/tmp/SKILL.md",
        createdAt: "2026-06-29T10:00:00.000Z",
        updatedAt: "2026-06-29T10:01:00.000Z",
        version: 2,
        metadata: { syncedBy: "test" },
      },
    ]);
  });

  it("upserts local skills by fingerprint and returns the remote row", async () => {
    const uploaded = localSkill();
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(`https://example.supabase.co/rest/v1/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?on_conflict=local_fingerprint`);
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).Prefer).toBe("resolution=merge-duplicates,return=representation");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          name: "review-code",
          agent: "codex",
          local_fingerprint: skillSyncFingerprint(uploaded),
          markdown: uploaded.markdown,
        });
        return new Response(JSON.stringify([{
          ...body,
          id: "remote-1",
          created_at: "2026-06-29T10:00:00.000Z",
          updated_at: "2026-06-29T10:01:00.000Z",
        }]), { status: 201 });
      },
    });

    await expect(client.upsertLocalSkill(uploaded)).resolves.toMatchObject({
      id: "remote-1",
      name: "review-code",
      localFingerprint: skillSyncFingerprint(uploaded),
    });
  });

  it("updates a remote skill by id when the local binding is known", async () => {
    const uploaded = localSkill();
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(`https://example.supabase.co/rest/v1/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?id=eq.remote-1`);
        expect(init?.method).toBe("PATCH");
        expect((init?.headers as Record<string, string>).Prefer).toBe("return=representation");
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify([{
          ...body,
          id: "remote-1",
          created_at: "2026-06-29T10:00:00.000Z",
          updated_at: "2026-06-29T10:02:00.000Z",
        }]), { status: 200 });
      },
    });

    await expect(client.updateRemoteSkill("remote-1", uploaded)).resolves.toMatchObject({
      id: "remote-1",
      updatedAt: "2026-06-29T10:02:00.000Z",
    });
  });

  it("fetches one remote skill by id before installing it locally", async () => {
    const remote = remoteSkill();
    const client = new SupabaseSkillSyncClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url) => {
        expect(String(url)).toBe(`https://example.supabase.co/rest/v1/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?id=eq.remote-1&select=*&limit=1`);
        return new Response(JSON.stringify([{
          id: remote.id,
          name: remote.name,
          description: remote.description,
          agent: remote.agent,
          source: remote.source,
          markdown: remote.markdown,
          local_fingerprint: remote.localFingerprint,
          uploaded_from_path: remote.uploadedFromPath,
          created_at: remote.createdAt,
          updated_at: remote.updatedAt,
          version: remote.version,
          metadata: remote.metadata,
        }]), { status: 200 });
      },
    });

    await expect(client.getRemoteSkill("remote-1")).resolves.toEqual(remote);
  });
});
