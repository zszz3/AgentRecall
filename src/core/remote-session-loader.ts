import * as path from "node:path";
import { loadClaudeCliSessionRows, loadCodeWizSessions, loadCodexSessionRows, parseCodexSessionMetaLine, parseJsonlText } from "./session-loader";
import type { ClaudeConversationLine, CodexConversationLine, LoadedSession, SessionEnvironment, SessionSearchResult } from "./types";

export type RemoteSessionFileKind = "codex-session" | "codex-index" | "claude-project" | "claude-session-index" | "codewiz-session";

export interface RemoteSessionFilePayload {
  kind: RemoteSessionFileKind;
  path: string;
  mtimeMs: number;
  size: number;
  content: string;
}

export function loadRemoteSessionPayloads(environment: SessionEnvironment, payloads: RemoteSessionFilePayload[]): LoadedSession[] {
  const codexTitleMap = readCodexTitleMap(payloads);
  const claudeIndexMap = readClaudeIndexMap(payloads);
  const loaded: LoadedSession[] = [];

  for (const payload of payloads) {
    if (payload.kind === "codex-session") {
      const rows = parseJsonlText(payload.content);
      const meta = rows.length > 0 ? parseCodexSessionMetaLine(rows[0] as CodexConversationLine) : null;
      const indexedTitle = meta ? codexTitleMap.get(meta.id) : undefined;
      const candidate = loadCodexSessionRows(payload.path, rows, {
        stat: { mtimeMs: payload.mtimeMs, size: payload.size },
        sourceOverride: "codex-cli",
        title: indexedTitle?.title,
        updatedAt: indexedTitle?.updatedAt,
      });
      if (candidate) loaded.push(scopeRemoteSession(candidate, environment, "codex"));
    } else if (payload.kind === "claude-project") {
      const rows = parseJsonlText(payload.content);
      const relation = claudeRemoteRelation(payload.path, rows);
      const rawId = relation.agentId || path.basename(payload.path, ".jsonl");
      const index = claudeIndexMap.get(rawId);
      const candidate = loadClaudeCliSessionRows(payload.path, rows, {
        rawId,
        cwd: index?.cwd,
        startedAt: index?.startedAt,
        stat: { mtimeMs: payload.mtimeMs, size: payload.size },
        isSubagent: relation.isSubagent,
        parentSessionId: relation.parentSessionId,
      });
      if (candidate) loaded.push(scopeRemoteSession(candidate, environment, "claude"));
    }
  }

  return loaded;
}

export function loadRemoteSessionDetailPayload(
  environment: SessionEnvironment,
  payload: RemoteSessionFilePayload,
  summary: SessionSearchResult,
): LoadedSession | null {
  if (payload.kind === "codex-session") {
    const candidate = loadCodexSessionRows(payload.path, parseJsonlText(payload.content), {
      stat: { mtimeMs: payload.mtimeMs, size: payload.size },
      sourceOverride: "codex-cli",
      title: summary.originalTitle,
    });
    return candidate ? scopeRemoteSession(candidate, environment, "codex") : null;
  }

  if (payload.kind === "claude-project") {
    const rawId = path.basename(payload.path, ".jsonl");
    const candidate = loadClaudeCliSessionRows(payload.path, parseJsonlText(payload.content), {
      rawId,
      cwd: summary.projectPath,
      startedAt: summary.timestamp,
      stat: { mtimeMs: payload.mtimeMs, size: payload.size },
      isSubagent: summary.isSubagent,
      parentSessionId: summary.parentSessionId,
    });
    return candidate ? scopeRemoteSession(candidate, environment, "claude") : null;
  }

  if (payload.kind === "codewiz-session") {
    const [dbPath, sessionId] = payload.path.split("#", 2);
    const candidate = loadCodeWizSessions(path.dirname(dbPath)).find((item) => item.session.rawId === sessionId);
    return candidate ? scopeRemoteSession(candidate, environment, "codewiz") : null;
  }

  return null;
}

function claudeRemoteRelation(
  filePath: string,
  rows: unknown[],
): { isSubagent: boolean; parentSessionId: string | null; agentId: string | null } {
  const relationRow = rows.find(
    (row): row is ClaudeConversationLine =>
      Boolean(row && typeof row === "object" && ("sessionId" in row || "agentId" in row || "isSidechain" in row)),
  );
  const pathParts = filePath.split(/[\\/]/);
  const subagentsIndex = pathParts.lastIndexOf("subagents");
  const inSubagentsDirectory = subagentsIndex >= 0;
  const isSubagent = inSubagentsDirectory || relationRow?.isSidechain === true;
  const pathParent = subagentsIndex > 0 ? pathParts[subagentsIndex - 1] : null;
  return {
    isSubagent,
    parentSessionId: isSubagent ? relationRow?.sessionId || pathParent : null,
    agentId: isSubagent
      ? relationRow?.agentId || path.basename(filePath, ".jsonl").replace(/^agent-?/, "")
      : null,
  };
}

function scopeRemoteSession(loaded: LoadedSession, environment: SessionEnvironment, family: "codex" | "claude" | "codewiz"): LoadedSession {
  return {
    ...loaded,
    session: {
      ...loaded.session,
      sessionKey: `ssh:${environment.id}:${family}:${loaded.session.rawId}`,
      environmentId: environment.id,
      environmentKind: environment.kind,
      environmentLabel: environment.label,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readCodexTitleMap(payloads: RemoteSessionFilePayload[]): Map<string, { title: string; updatedAt: string }> {
  const map = new Map<string, { title: string; updatedAt: string }>();
  for (const payload of payloads.filter((item) => item.kind === "codex-index")) {
    for (const row of parseJsonlText(payload.content)) {
      if (!isRecord(row)) continue;
      const id = typeof row.id === "string" ? row.id : "";
      const title = typeof row.thread_name === "string" ? row.thread_name : "";
      const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
      if (id && title) map.set(id, { title, updatedAt });
    }
  }
  return map;
}

function readClaudeIndexMap(payloads: RemoteSessionFilePayload[]): Map<string, { cwd: string; startedAt: number }> {
  const map = new Map<string, { cwd: string; startedAt: number }>();
  for (const payload of payloads.filter((item) => item.kind === "claude-session-index")) {
    try {
      const parsed = JSON.parse(payload.content) as unknown;
      if (!isRecord(parsed) || typeof parsed.sessionId !== "string") continue;
      const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
      const startedAt = typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt) ? parsed.startedAt : 0;
      map.set(parsed.sessionId, { cwd, startedAt });
    } catch {
      // Ignore malformed remote metadata.
    }
  }
  return map;
}
