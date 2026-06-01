import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanTitle, getAdapter, isMeaningfulUserMessage } from "./format-adapters";
import type {
  ClaudeAppSessionFile,
  ClaudeConversationLine,
  ClaudeSessionIndexFile,
  CodexConversationLine,
  IndexedSession,
  LoadedSession,
  SessionFormat,
  SessionMessage,
  SessionSource,
} from "./types";

const CODEX_APP_ORIGINATOR = "Codex Desktop";

export function parseCodexSessionMetaLine(parsed: CodexConversationLine): {
  id: string;
  projectPath: string;
  ts: number;
  gitBranch?: string;
  originator?: string;
} | null {
  if (parsed.type === "session_meta" && parsed.payload?.id) {
    return {
      id: parsed.payload.id,
      projectPath: parsed.payload.cwd || "",
      ts: parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0,
      gitBranch: parsed.payload.git?.branch,
      originator: parsed.payload.originator,
    };
  }

  if (parsed.id && parsed.timestamp && !parsed.type) {
    return {
      id: parsed.id,
      projectPath: parsed.git?.cwd || "",
      ts: new Date(parsed.timestamp).getTime(),
    };
  }

  return null;
}

function safeStat(filePath: string): { mtimeMs: number; size: number } {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function readJsonl(filePath: string): unknown[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const rows: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Keep parsing the rest of the JSONL file.
    }
  }
  return rows;
}

function extractMessages(rows: unknown[], format: SessionFormat): SessionMessage[] {
  const adapter = getAdapter(format);
  const messages: SessionMessage[] = [];
  for (const raw of rows) {
    const parsed = adapter.parseLine(raw);
    if (!parsed) continue;
    if (parsed.role === "user" && !isMeaningfulUserMessage(parsed.content)) continue;
    messages.push({ ...parsed, index: messages.length });
  }
  return messages;
}

function firstQuestion(messages: SessionMessage[]): string {
  return messages.find((message) => message.role === "user" && isMeaningfulUserMessage(message.content))?.content || "";
}

function firstClaudeGitBranch(rows: unknown[]): string | null {
  for (const row of rows) {
    if (!row || typeof row !== "object" || !("gitBranch" in row)) continue;
    const branch = (row as ClaudeConversationLine).gitBranch?.trim();
    if (branch) return branch;
  }
  return null;
}

function createIndexedSession(input: {
  family: "claude" | "codex";
  rawId: string;
  source: SessionSource;
  projectPath: string;
  filePath: string;
  originalTitle: string;
  firstQuestion: string;
  timestamp: number;
  prUrl?: string | null;
  prNumber?: number | null;
  gitBranch?: string | null;
}): IndexedSession {
  const stat = safeStat(input.filePath);
  return {
    sessionKey: `${input.family}:${input.rawId}`,
    rawId: input.rawId,
    source: input.source,
    projectPath: input.projectPath,
    filePath: input.filePath,
    originalTitle: input.originalTitle || input.firstQuestion || "Untitled Session",
    firstQuestion: input.firstQuestion,
    timestamp: input.timestamp || stat.mtimeMs,
    fileMtimeMs: stat.mtimeMs,
    fileSize: stat.size,
    prUrl: input.prUrl ?? null,
    prNumber: input.prNumber ?? null,
    gitBranch: input.gitBranch ?? null,
  };
}

export function loadCodexSessionFile(filePath: string, title?: string, updatedAt?: string): LoadedSession | null {
  const rows = readJsonl(filePath);
  if (rows.length === 0) return null;

  const meta = parseCodexSessionMetaLine(rows[0] as CodexConversationLine);
  if (!meta) return null;

  const messages = extractMessages(rows, "codex");
  const question = firstQuestion(messages);
  const source: SessionSource = meta.originator === CODEX_APP_ORIGINATOR ? "codex-app" : "codex-cli";
  const session = createIndexedSession({
    family: "codex",
    rawId: meta.id,
    source,
    projectPath: meta.projectPath,
    filePath,
    originalTitle: title || cleanTitle(question) || "Untitled Session",
    firstQuestion: question ? cleanTitle(question) : "",
    timestamp: updatedAt ? new Date(updatedAt).getTime() : meta.ts,
    gitBranch: meta.gitBranch,
  });

  return { session, messages };
}

function walkJsonlFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonlFiles(fullPath));
    else if (entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files;
}

export function loadCodexSessions(codexDir = path.join(os.homedir(), ".codex")): LoadedSession[] {
  return [...loadCodexSessionsIterator(codexDir)];
}

export function* loadCodexSessionsIterator(codexDir = path.join(os.homedir(), ".codex")): Generator<LoadedSession> {
  const sessionsDir = path.join(codexDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return;

  const titleMap = new Map<string, { title: string; updatedAt: string }>();
  const indexPath = path.join(codexDir, "session_index.jsonl");
  if (fs.existsSync(indexPath)) {
    for (const row of readJsonl(indexPath) as Array<{ id?: string; thread_name?: string; updated_at?: string }>) {
      if (row.id && row.thread_name) titleMap.set(row.id, { title: row.thread_name, updatedAt: row.updated_at || "" });
    }
  }

  for (const filePath of walkJsonlFiles(sessionsDir)) {
    const rows = readJsonl(filePath);
    const meta = rows.length > 0 ? parseCodexSessionMetaLine(rows[0] as CodexConversationLine) : null;
    if (!meta) continue;
    const indexedTitle = titleMap.get(meta.id);
    const messages = extractMessages(rows, "codex");
    const question = firstQuestion(messages);
    const source: SessionSource = meta.originator === CODEX_APP_ORIGINATOR ? "codex-app" : "codex-cli";
    yield {
      session: createIndexedSession({
        family: "codex",
        rawId: meta.id,
        source,
        projectPath: meta.projectPath,
        filePath,
        originalTitle: indexedTitle?.title || cleanTitle(question) || "Untitled Session",
        firstQuestion: question ? cleanTitle(question) : "",
        timestamp: indexedTitle?.updatedAt ? new Date(indexedTitle.updatedAt).getTime() : meta.ts,
        gitBranch: meta.gitBranch,
      }),
      messages,
    };
  }
}

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

function loadClaudeMessages(filePath: string): SessionMessage[] {
  return extractMessages(readJsonl(filePath), "claude");
}

export function loadClaudeCliSessions(claudeDir = path.join(os.homedir(), ".claude")): LoadedSession[] {
  return [...loadClaudeCliSessionsIterator(claudeDir)];
}

export function* loadClaudeCliSessionsIterator(claudeDir = path.join(os.homedir(), ".claude")): Generator<LoadedSession> {
  const sessionsDir = path.join(claudeDir, "sessions");
  const projectsDir = path.join(claudeDir, "projects");
  if (!fs.existsSync(projectsDir)) return;

  const index = new Map<string, ClaudeSessionIndexFile>();
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), "utf-8")) as ClaudeSessionIndexFile;
        if (parsed.sessionId) index.set(parsed.sessionId, parsed);
      } catch {
        // Ignore malformed index files.
      }
    }
  }

  for (const projectDir of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, projectDir);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) continue;
    for (const file of fs.readdirSync(projectPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const rawId = file.replace(/\.jsonl$/, "");
      const filePath = path.join(projectPath, file);
      const rows = readJsonl(filePath);
      const messages = extractMessages(rows, "claude");
      const question = firstQuestion(messages);
      const embeddedCwd = (rows.find((row) => row && typeof row === "object" && "cwd" in row) as
        | ClaudeConversationLine
        | undefined)?.cwd;
      const gitBranch = firstClaudeGitBranch(rows);
      yield {
        session: createIndexedSession({
          family: "claude",
          rawId,
          source: "claude-cli",
          projectPath: index.get(rawId)?.cwd || embeddedCwd || "",
          filePath,
          originalTitle: cleanTitle(question) || "Untitled Session",
          firstQuestion: cleanTitle(question),
          timestamp: index.get(rawId)?.startedAt || 0,
          gitBranch,
        }),
        messages,
      };
    }
  }
}

export function loadClaudeAppSessions(
  appSessionsDir = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
  claudeDir = path.join(os.homedir(), ".claude"),
): LoadedSession[] {
  return [...loadClaudeAppSessionsIterator(appSessionsDir, claudeDir)];
}

export function* loadClaudeAppSessionsIterator(
  appSessionsDir = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
  claudeDir = path.join(os.homedir(), ".claude"),
): Generator<LoadedSession> {
  if (!fs.existsSync(appSessionsDir)) return;
  const projectsDir = path.join(claudeDir, "projects");
  const metaFiles: string[] = [];

  for (const userDir of fs.readdirSync(appSessionsDir)) {
    const userPath = path.join(appSessionsDir, userDir);
    if (!fs.existsSync(userPath) || !fs.statSync(userPath).isDirectory()) continue;
    for (const workspaceDir of fs.readdirSync(userPath)) {
      const workspacePath = path.join(userPath, workspaceDir);
      if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) continue;
      for (const entry of fs.readdirSync(workspacePath)) {
        if (entry.startsWith("local_") && entry.endsWith(".json")) metaFiles.push(path.join(workspacePath, entry));
      }
    }
  }

  for (const metaPath of metaFiles) {
    let appMeta: ClaudeAppSessionFile;
    try {
      appMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as ClaudeAppSessionFile;
    } catch {
      continue;
    }
    const rawId = appMeta.cliSessionId || appMeta.sessionId;
    const cwd = appMeta.cwd || appMeta.originCwd || "";
    const convoPath =
      rawId && cwd ? path.join(projectsDir, encodeClaudeProjectDir(cwd), `${rawId}.jsonl`) : metaPath;
    const rows = fs.existsSync(convoPath) ? readJsonl(convoPath) : [];
    const messages = extractMessages(rows, "claude");
    const question = firstQuestion(messages);
    const title = appMeta.title && !/^Session\s+\d+$/i.test(appMeta.title) ? appMeta.title : cleanTitle(question);
    const gitBranch = firstClaudeGitBranch(rows);
    yield {
      session: createIndexedSession({
        family: "claude",
        rawId,
        source: "claude-app",
        projectPath: cwd,
        filePath: convoPath,
        originalTitle: title || "Untitled Session",
        firstQuestion: cleanTitle(question),
        timestamp: appMeta.lastActivityAt || appMeta.createdAt || 0,
        prUrl: appMeta.prUrl || null,
        prNumber: appMeta.prNumber || null,
        gitBranch,
      }),
      messages,
    };
  }
}

export function loadDefaultSessions(): LoadedSession[] {
  return [...loadDefaultSessionsIterator()];
}

export function* loadDefaultSessionsIterator(): Generator<LoadedSession> {
  yield* loadClaudeCliSessionsIterator();
  yield* loadClaudeAppSessionsIterator();
  yield* loadCodexSessionsIterator();
}
