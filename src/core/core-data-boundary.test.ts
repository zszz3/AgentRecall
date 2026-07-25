import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CORE_SESSION_SOURCES } from "../shared/product-profile";
import { syncDefaultSessionsInBatches, syncLoadedSessionsInBatches } from "./indexer";
import { createInMemoryStore } from "./session-store";
import type { IndexedSession, LoadedSession, SessionSource } from "./types";

const ALL_SESSION_SOURCES = [
  "claude-cli",
  "claude-app",
  "claude-internal",
  "codex-cli",
  "codex-app",
  "codex-internal",
  "tclaude-cli",
  "tcodex-cli",
  "codebuddy-cli",
  "codewiz-cli",
  "openclaw",
  "hermes",
  "opencode-cli",
  "cursor-agent",
  "trae",
] as const satisfies readonly SessionSource[];

function indexedSession(
  source: SessionSource,
  index: number,
  overrides: Partial<IndexedSession> = {},
): IndexedSession {
  const id = `${source}-${index}`;
  return {
    sessionKey: `${source}:${id}`,
    rawId: id,
    source,
    projectPath: `/projects/${source}`,
    filePath: `/synthetic/${id}.jsonl`,
    originalTitle: `Boundary marker ${source}`,
    firstQuestion: `Boundary marker ${source}`,
    timestamp: index + 1,
    fileMtimeMs: index + 1,
    fileSize: 100 + index,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

function loadedSession(source: SessionSource, index: number): LoadedSession {
  return {
    session: indexedSession(source, index),
    messages: [{
      role: "user",
      content: `Boundary marker ${source}`,
      timestamp: "2026-07-25T00:00:00.000Z",
      index: 0,
    }],
  };
}

describe("core-v1 data boundary", () => {
  it("indexes only the four explicitly allowed local product sources", async () => {
    const store = createInMemoryStore();
    try {
      const remoteOfficial = loadedSession("codex-cli", 100);
      remoteOfficial.session = {
        ...remoteOfficial.session,
        sessionKey: "ssh-test:codex-cli:remote-index",
        environmentId: "ssh-test",
        environmentKind: "ssh",
        environmentLabel: "Remote test",
      };
      const status = await syncLoadedSessionsInBatches(
        store,
        [...ALL_SESSION_SOURCES.map(loadedSession), remoteOfficial],
        {
          allowedSources: CORE_SESSION_SOURCES,
          batchSize: 50,
          yieldToEventLoop: async () => undefined,
        },
      );

      expect(status).toMatchObject({ indexed: 4, skipped: 0, total: 4 });
      expect(
        store.searchSessions({ limit: 100 }).map((session) => session.source).sort(),
      ).toEqual([...CORE_SESSION_SOURCES].sort());
      for (const source of ALL_SESSION_SOURCES.filter(
        (candidate) => !CORE_SESSION_SOURCES.includes(candidate as (typeof CORE_SESSION_SOURCES)[number]),
      )) {
        expect(store.getSession(`${source}:${source}-${ALL_SESSION_SOURCES.indexOf(source)}`)).toBeNull();
      }
      expect(store.getSession(remoteOfficial.session.sessionKey)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("scopes search, tags, and project metadata to local official sources", () => {
    const store = createInMemoryStore();
    try {
      CORE_SESSION_SOURCES.forEach((source, index) => {
        const session = indexedSession(source, index);
        store.upsertIndexedSession(session, loadedSession(source, index).messages);
        store.addTag(session.sessionKey, "official");
      });

      const advanced = indexedSession("openclaw", 10);
      store.upsertIndexedSession(advanced, loadedSession("openclaw", 10).messages);
      store.addTag(advanced.sessionKey, "advanced-only");

      store.upsertEnvironment({
        id: "ssh-test",
        kind: "ssh",
        label: "Remote test",
        host: "example.invalid",
        authMode: "none",
        enabled: false,
      });
      const remote = indexedSession("codex-cli", 11, {
        sessionKey: "ssh-test:codex-cli:remote",
        rawId: "remote",
        environmentId: "ssh-test",
        environmentKind: "ssh",
        environmentLabel: "Remote test",
        projectPath: "/projects/remote",
      });
      store.upsertIndexedSession(remote, loadedSession("codex-cli", 11).messages);
      store.addTag(remote.sessionKey, "remote-only");

      const scope = {
        environmentId: "local",
        allowedSources: CORE_SESSION_SOURCES,
      } as const;
      const page = store.searchSessionPage({
        ...scope,
        query: "Boundary marker",
        limit: 100,
      });

      expect(page.totalCount).toBe(4);
      expect(page.sessions.map((session) => session.source).sort()).toEqual(
        [...CORE_SESSION_SOURCES].sort(),
      );
      expect(store.listTags(scope)).toEqual(["official"]);
      expect(store.listProjects(scope).map((project) => project.path).sort()).toEqual(
        CORE_SESSION_SOURCES.map((source) => `/projects/${source}`).sort(),
      );
      expect(store.listTagsByProject(scope)).toHaveLength(4);
      expect(store.listTagsByProject(scope).every((entry) => entry.tags.join() === "official")).toBe(true);

      expect(store.searchSessionPage({ ...scope, allowedSources: [], limit: 100 })).toMatchObject({
        sessions: [],
        totalCount: 0,
      });
      expect(store.listTags({ ...scope, allowedSources: [] })).toEqual([]);
      expect(store.listProjects({ ...scope, allowedSources: [] })).toEqual([]);
      expect(store.listTagsByProject({ ...scope, allowedSources: [] })).toEqual([]);

      // Product scoping hides advanced and remote rows; it does not migrate or
      // delete them from the retained database.
      expect(store.getSession(advanced.sessionKey)).toMatchObject({ source: "openclaw" });
      expect(store.getSession(remote.sessionKey)).toMatchObject({
        source: "codex-cli",
        environmentId: "ssh-test",
      });
    } finally {
      store.close();
    }
  });

  it("keeps Windows-style project paths inside the same local source boundary", () => {
    const store = createInMemoryStore();
    try {
      const official = indexedSession("codex-cli", 30, {
        projectPath: "C:\\Users\\Ada\\AgentRecall",
        filePath: "C:\\Users\\Ada\\.codex\\sessions\\official.jsonl",
      });
      store.upsertIndexedSession(official, loadedSession("codex-cli", 30).messages);
      store.addTag(official.sessionKey, "windows-official");

      const advanced = indexedSession("openclaw", 31, {
        projectPath: "C:\\Users\\Ada\\AdvancedAgent",
        filePath: "C:\\Users\\Ada\\.openclaw\\advanced.jsonl",
      });
      store.upsertIndexedSession(advanced, loadedSession("openclaw", 31).messages);
      store.addTag(advanced.sessionKey, "windows-advanced");

      store.upsertEnvironment({
        id: "ssh-windows",
        kind: "ssh",
        label: "Remote Windows",
        host: "example.invalid",
        authMode: "none",
        enabled: false,
      });
      const remote = indexedSession("codex-cli", 32, {
        sessionKey: "ssh-windows:codex-cli:remote",
        environmentId: "ssh-windows",
        environmentKind: "ssh",
        environmentLabel: "Remote Windows",
        projectPath: "C:\\Users\\Remote\\AgentRecall",
        filePath: "C:\\Users\\Remote\\.codex\\sessions\\remote.jsonl",
      });
      store.upsertIndexedSession(remote, loadedSession("codex-cli", 32).messages);
      store.addTag(remote.sessionKey, "windows-remote");

      const scope = {
        environmentId: "local",
        allowedSources: CORE_SESSION_SOURCES,
      } as const;
      const page = store.searchSessionPage({
        ...scope,
        query: "C:\\Users\\Ada\\AgentRecall",
        limit: 20,
      });

      expect(page.sessions).toMatchObject([{
        sessionKey: official.sessionKey,
        projectPath: "C:\\Users\\Ada\\AgentRecall",
      }]);
      expect(store.listProjects(scope)).toMatchObject([{
        path: "C:\\Users\\Ada\\AgentRecall",
        label: "AgentRecall",
        sessionCount: 1,
      }]);
      expect(store.listTags(scope)).toEqual(["windows-official"]);
      expect(store.listTagsByProject(scope)).toEqual([{
        environmentId: "local",
        projectPath: "C:\\Users\\Ada\\AgentRecall",
        tags: ["windows-official"],
      }]);
    } finally {
      store.close();
    }
  });

  it("keeps hidden-source records, metadata, and upstream files during a core refresh", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-core-index-"));
    const advancedPath = path.join(homeDir, "retained-openclaw.jsonl");
    const corePath = path.join(homeDir, "retained-codex.jsonl");
    fs.writeFileSync(advancedPath, "advanced sentinel", "utf8");
    fs.writeFileSync(corePath, "core sentinel", "utf8");
    const store = createInMemoryStore();
    const listStale = vi.spyOn(store, "listSessionKeysByFilePath");
    const deleteRecord = vi.spyOn(store, "deleteSessionRecord");

    try {
      const advanced = indexedSession("openclaw", 20, {
        filePath: advancedPath,
        fileMtimeMs: 20,
      });
      const core = indexedSession("codex-cli", 21, {
        filePath: corePath,
        fileMtimeMs: 21,
      });
      store.upsertIndexedSession(advanced, loadedSession("openclaw", 20).messages);
      store.upsertIndexedSession(core, loadedSession("codex-cli", 21).messages);
      store.setCustomTitle(advanced.sessionKey, "Retained advanced title");
      store.setFavorited(advanced.sessionKey, true);
      store.addTag(advanced.sessionKey, "retained-tag");

      await syncDefaultSessionsInBatches(store, {
        allowedSources: CORE_SESSION_SOURCES,
        pruneMissingSessions: false,
        loadOptions: { homeDir },
        yieldToEventLoop: async () => undefined,
      });

      expect(listStale).not.toHaveBeenCalled();
      expect(deleteRecord).not.toHaveBeenCalled();
      expect(store.getSession(advanced.sessionKey)).toMatchObject({
        source: "openclaw",
        customTitle: "Retained advanced title",
        favorited: true,
        tags: ["retained-tag"],
      });
      expect(store.getSession(core.sessionKey)).toMatchObject({ source: "codex-cli" });
      expect(fs.readFileSync(advancedPath, "utf8")).toBe("advanced sentinel");
      expect(fs.readFileSync(corePath, "utf8")).toBe("core sentinel");
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
