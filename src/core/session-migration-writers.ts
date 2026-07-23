import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { cleanTitle, extractCursorUserQuery } from "./format-adapters";
import {
  encodeCursorWorkspaceSlug,
  loadClaudeCliSessionRows,
  loadCodeBuddyCliSessionFile,
  loadCodeWizSessions,
  loadCodexSessionRows,
  loadCursorTranscriptFile,
  parseCursorTranscriptPath,
  parseJsonlText,
} from "./session-loader";
import { loadMigrationTargetRuntimeMetadata, type MigrationTargetRuntimeMetadata } from "./migration-target-runtime";
import { migrationTargetDescriptor } from "./migration-targets";
import type { LoadedSession, MigrationTarget, PortableSession } from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => import("node:sqlite").DatabaseSync;
};

export interface WriteMigratedSessionOptions {
  target: MigrationTarget;
  session: PortableSession;
  homeDir?: string;
  now?: Date;
  idFactory?: () => string;
  beforeValidate?: (filePath: string) => void | Promise<void>;
  validate?: (filePath: string) => LoadedSession | null | Promise<LoadedSession | null>;
  rename?: (oldPath: string, newPath: string) => void | Promise<void>;
}

export interface WrittenMigratedSession {
  sessionId: string;
  filePath: string;
}

export type WriteMigratedSessionResult = WrittenMigratedSession;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function writeMigratedSession(options: WriteMigratedSessionOptions): Promise<WrittenMigratedSession> {
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? new Date();
  const createId = options.idFactory ?? (() => crypto.randomUUID());
  const sessionId = nextUniqueUuid(createId, new Set());
  if (options.target === "codewiz") {
    return writeMigratedCodeWizSession({ ...options, homeDir, now, idFactory: createId }, sessionId);
  }
  const filePath = targetFilePath(options.target, options.session.projectPath, sessionId, homeDir, now);
  const targetHome = path.join(homeDir, TARGET_ROOTS[options.target]);
  const runtimeMetadata = await loadMigrationTargetRuntimeMetadata(options.target, targetHome);
  const rows = serializeSession(options.target, options.session, sessionId, createId, runtimeMetadata);
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  let finalFileCreated = false;

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeJsonlAndSync(tempPath, rows);
    if (options.beforeValidate) await options.beforeValidate(tempPath);
    const writtenRows = readJsonlStrict(tempPath, options.target);
    validateNativeStructure(options.target, writtenRows, sessionId, options.session, runtimeMetadata);
    const loaded = loadWrittenSession(options.target, tempPath, sessionId, options.session);
    validateRoundTrip(loaded, options.target, sessionId, options.session);
    if (options.validate) {
      const additionallyLoaded = await options.validate(tempPath);
      validateRoundTrip(additionallyLoaded, options.target, sessionId, options.session);
    }
    await fs.promises.chmod(tempPath, 0o600);
    if (options.rename) await options.rename(tempPath, filePath);
    else await fs.promises.rename(tempPath, filePath);
    finalFileCreated = true;
    await updateCodexSessionIndex(options.target, targetHome, options.session, sessionId, now);
    updateCodexAppServerState(options.target, targetHome, filePath, options.session, sessionId, now, runtimeMetadata);
    return { sessionId, filePath };
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    if (finalFileCreated) await fs.promises.rm(filePath, { force: true });
    throw error;
  }
}

async function writeMigratedCodeWizSession(
  options: WriteMigratedSessionOptions & { homeDir: string; now: Date; idFactory: () => string },
  sessionId: string,
): Promise<WrittenMigratedSession> {
  const dbPath = targetFilePath("codewiz", options.session.projectPath, sessionId, options.homeDir, options.now);
  await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    ensureCodeWizSchema(db);
    insertCodeWizSession(db, options.session, sessionId, options.idFactory, options.now);
  } finally {
    db.close();
  }

  const loaded = loadWrittenSession("codewiz", dbPath, sessionId, options.session);
  validateRoundTrip(loaded, "codewiz", sessionId, options.session);
  if (options.validate) {
    const additionallyLoaded = await options.validate(dbPath);
    validateRoundTrip(additionallyLoaded, "codewiz", sessionId, options.session);
  }
  await fs.promises.chmod(dbPath, 0o600);
  return { sessionId, filePath: dbPath };
}

function serializeSession(
  target: MigrationTarget,
  session: PortableSession,
  sessionId: string,
  createId: () => string,
  runtimeMetadata: MigrationTargetRuntimeMetadata,
): unknown[] {
  if (target === "cursor") return serializeCursor(session);
  const family = migrationTargetDescriptor(target).family;
  if (family === "codex") {
    return serializeCodex(
      session,
      sessionId,
      requiredRuntimeValue(runtimeMetadata.codexModelProvider, "Codex model provider"),
      target === "codex" && process.platform === "win32",
    );
  }
  if (family === "claude") {
    return serializeClaude(session, sessionId, createId, requiredRuntimeValue(runtimeMetadata.claudeModel, "Claude model"));
  }
  return serializeCodeBuddy(session, sessionId, createId);
}

function serializeCodex(
  session: PortableSession,
  sessionId: string,
  modelProvider: string,
  includeVsCodeEvents: boolean,
): unknown[] {
  const rows: unknown[] = [{
    type: "session_meta",
    timestamp: session.startedAt,
    payload: {
      ...(includeVsCodeEvents ? { session_id: sessionId } : {}),
      id: sessionId,
      timestamp: session.startedAt,
      cwd: session.projectPath,
      title: session.title,
      originator: "agent-recall",
      cli_version: "migration",
      ...(includeVsCodeEvents ? { source: "vscode", thread_source: "user", history_mode: "legacy" } : {}),
      model_provider: modelProvider,
    },
  }];

  if (includeVsCodeEvents) {
    rows.push({
      type: "event_msg",
      timestamp: session.startedAt,
      payload: {
        type: "task_started",
        turn_id: sessionId,
        started_at: Math.floor(new Date(session.startedAt).getTime() / 1000),
        model_context_window: 0,
        collaboration_mode_kind: "default",
      },
    });
  }

  for (const message of session.messages) {
    rows.push({
      type: "response_item",
      timestamp: message.timestamp,
      payload: {
        type: "message",
        role: message.role,
        content: [{
          type: message.role === "user" ? "input_text" : "output_text",
          text: message.content,
        }],
      },
    });
    if (includeVsCodeEvents) {
      rows.push({
        type: "event_msg",
        timestamp: message.timestamp,
        payload: message.role === "user"
          ? { type: "user_message", message: message.content, images: [], local_images: [], text_elements: [] }
          : { type: "agent_message", message: message.content, phase: "final_answer" },
      });
    }
  }

  return rows;
}

function serializeClaude(
  session: PortableSession,
  sessionId: string,
  createId: () => string,
  model: string,
): unknown[] {
  const usedIds = new Set<string>([sessionId]);
  let parentUuid: string | null = null;
  const rows: unknown[] = [{
    type: "ai-title",
    aiTitle: session.title,
    sessionId,
  }];

  for (const portableMessage of session.messages) {
    const uuid = nextUniqueUuid(createId, usedIds);
    const message = portableMessage.role === "user"
      ? { role: "user", content: portableMessage.content }
      : {
          model,
          id: `msg_${uuid}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: portableMessage.content }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        };

    rows.push({
      parentUuid,
      isSidechain: false,
      type: portableMessage.role,
      message,
      uuid,
      timestamp: portableMessage.timestamp,
      userType: "external",
      entrypoint: "cli",
      cwd: session.projectPath,
      sessionId,
      version: "migration",
    });
    parentUuid = uuid;
  }
  return rows;
}

function serializeCodeBuddy(
  session: PortableSession,
  sessionId: string,
  createId: () => string,
): unknown[] {
  const usedIds = new Set<string>([sessionId]);
  let parentId: string | undefined;
  const rows: unknown[] = [{
    timestamp: timestampMs(session.startedAt),
    type: "ai-title",
    aiTitle: session.title,
    sessionId,
    cwd: session.projectPath,
  }];

  for (const message of session.messages) {
    const id = nextUniqueUuid(createId, usedIds);
    rows.push({
      id,
      ...(parentId ? { parentId } : {}),
      timestamp: timestampMs(message.timestamp),
      type: "message",
      role: message.role,
      content: [{
        type: message.role === "user" ? "input_text" : "output_text",
        text: message.content,
      }],
      sessionId,
      cwd: session.projectPath,
    });
    parentId = id;
  }
  return rows;
}

function ensureCodeWizSchema(db: import("node:sqlite").DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id text PRIMARY KEY,
      worktree text NOT NULL,
      vcs text,
      name text,
      icon_url text,
      icon_color text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      time_initialized integer,
      sandboxes text NOT NULL,
      commands text
    );
    CREATE TABLE IF NOT EXISTS session (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      parent_id text,
      slug text NOT NULL,
      directory text NOT NULL,
      title text NOT NULL,
      version text NOT NULL,
      share_url text,
      summary_additions integer,
      summary_deletions integer,
      summary_files integer,
      summary_diffs text,
      revert text,
      permission text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      time_compacting integer,
      time_archived integer,
      workspace_id text
    );
    CREATE TABLE IF NOT EXISTS message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
}

function insertCodeWizSession(
  db: import("node:sqlite").DatabaseSync,
  session: PortableSession,
  sessionId: string,
  createId: () => string,
  now: Date,
): void {
  const nowMs = now.getTime();
  const projectId = crypto.createHash("sha1").update(session.projectPath || "/").digest("hex");
  const insertProject = db.prepare(`
    INSERT OR IGNORE INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands)
    VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, '[]', NULL)
  `);
  const insertSession = db.prepare(`
    INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived, workspace_id)
    VALUES (?, ?, NULL, ?, ?, ?, 'migration', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertPart = db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    insertProject.run(projectId, session.projectPath || "/", nowMs, nowMs);
    insertSession.run(
      sessionId,
      projectId,
      slugFromTitle(session.title || sessionId),
      session.projectPath,
      session.title || sessionId,
      timestampMs(session.startedAt) || nowMs,
      nowMs,
    );
    let parentId: string | null = null;
    const usedIds = new Set<string>([sessionId]);
    for (const message of session.messages) {
      const messageId = `msg_${nextUniqueUuid(createId, usedIds).replace(/-/g, "")}`;
      const partId = `prt_${nextUniqueUuid(createId, usedIds).replace(/-/g, "")}`;
      const messageTime = timestampMs(message.timestamp) || nowMs;
      insertMessage.run(
        messageId,
        sessionId,
        messageTime,
        messageTime,
        JSON.stringify({
          role: message.role,
          time: { created: messageTime, ...(message.role === "assistant" ? { completed: messageTime } : {}) },
          ...(parentId ? { parentID: parentId } : {}),
          modelID: "session-migration",
          providerID: "codewiz",
          mode: "build",
          agent: "build",
          path: { cwd: session.projectPath, root: session.projectPath },
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
      insertPart.run(
        partId,
        messageId,
        sessionId,
        messageTime,
        messageTime,
        JSON.stringify({ type: "text", text: message.content }),
      );
      parentId = messageId;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function slugFromTitle(title: string): string {
  return cleanTitle(title).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "migrated-session";
}

function normalizeCursorMigrationContent(content: string, role: "user" | "assistant"): string {
  return role === "user" ? extractCursorUserQuery(content) : content;
}

function serializeCursor(session: PortableSession): unknown[] {
  return session.messages.map((message) => {
    const normalizedContent = normalizeCursorMigrationContent(message.content, message.role);
    const text = message.role === "user"
      ? formatCursorUserContent(normalizedContent, message.timestamp)
      : normalizedContent;
    return {
      role: message.role,
      message: {
        content: [{ type: "text", text }],
      },
    };
  });
}

function formatCursorUserContent(content: string, timestamp: string): string {
  const timestampBlock = timestamp.trim() ? `<timestamp>${timestamp}</timestamp>\n` : "";
  return `${timestampBlock}<user_query>\n${content}\n</user_query>`;
}

export function targetFilePath(
  target: MigrationTarget,
  projectPath: string,
  sessionId: string,
  homeDir: string,
  now: Date,
): string {
  const family = migrationTargetDescriptor(target).family;
  if (family === "codewiz") return path.join(homeDir, ".local", "share", "codewiz", "opencode.db");
  const root = TARGET_ROOTS[target];
  if (family === "codex") {
    const year = String(now.getUTCFullYear()).padStart(4, "0");
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    const safeTimestamp = now.toISOString().replace(/[:.]/g, "-");
    return path.join(homeDir, root, "sessions", year, month, day, `rollout-${safeTimestamp}-${sessionId}.jsonl`);
  }

  if (family === "claude") {
    return path.join(homeDir, root, "projects", encodeClaudeProjectDir(projectPath), `${sessionId}.jsonl`);
  }

  if (target === "cursor") {
    const workspaceSlug = encodeCursorWorkspaceSlug(projectPath);
    return path.join(
      homeDir,
      ".cursor",
      "projects",
      workspaceSlug,
      "agent-transcripts",
      sessionId,
      `${sessionId}.jsonl`,
    );
  }

  return path.join(homeDir, root, "projects", encodeCodeBuddyProjectDir(projectPath), `${sessionId}.jsonl`);
}

const TARGET_ROOTS: Record<MigrationTarget, string> = {
  claude: ".claude",
  tclaude: ".tclaude",
  "claude-internal": ".claude-internal",
  codex: ".codex",
  tcodex: ".tcodex",
  "codex-internal": ".codex-internal",
  codebuddy: ".codebuddy",
  codewiz: path.join(".local", "share", "codewiz"),
  cursor: ".cursor",
};

function encodeClaudeProjectDir(projectPath: string): string {
  return encodeProjectDirectory(projectPath);
}

function encodeCodeBuddyProjectDir(projectPath: string): string {
  return projectPath.replace(/^[/\\]+/, "").replace(/[^a-zA-Z0-9-]/g, "-");
}

export function encodeProjectDirectory(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, "-");
}

function nextUniqueUuid(createId: () => string, usedIds: Set<string>): string {
  const id = createId();
  if (!UUID_PATTERN.test(id)) throw new Error(`Migration id must be a valid UUID: ${id}`);
  if (usedIds.has(id)) throw new Error(`Migration ids must be unique: ${id}`);
  usedIds.add(id);
  return id;
}

function timestampMs(value: string): number {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`Migration timestamp is invalid: ${value}`);
  return timestamp;
}

async function writeJsonlAndSync(filePath: string, rows: unknown[]): Promise<void> {
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function updateCodexSessionIndex(
  target: MigrationTarget,
  targetHome: string,
  session: PortableSession,
  sessionId: string,
  now: Date,
): Promise<void> {
  if (migrationTargetDescriptor(target).family !== "codex") return;

  const indexPath = path.join(targetHome, "session_index.jsonl");
  let existingRows: unknown[] = [];
  try {
    existingRows = readCodexSessionIndex(indexPath);
  } catch (error) {
    throw new Error(
      `Codex session index could not be read from ${indexPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rows = existingRows.filter((row) => !isRecord(row) || row.id !== sessionId);
  rows.push({
    id: sessionId,
    thread_name: session.title || sessionId,
    updated_at: now.toISOString(),
  });

  const tempPath = `${indexPath}.tmp-${crypto.randomUUID()}`;
  try {
    await writeJsonlAndSync(tempPath, rows);
    await fs.promises.rename(tempPath, indexPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw new Error(
      `Codex session index could not be updated at ${indexPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function updateCodexAppServerState(
  target: MigrationTarget,
  targetHome: string,
  filePath: string,
  session: PortableSession,
  sessionId: string,
  now: Date,
  runtimeMetadata: MigrationTargetRuntimeMetadata,
): void {
  if (target !== "codex" || process.platform !== "win32") return;

  const statePath = findCodexStateDatabase(targetHome);
  if (!statePath) return;

  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new DatabaseSync(statePath, { timeout: 5_000 });
    const columns = new Set(
      (db.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>)
        .map((column) => typeof column.name === "string" ? column.name : ""),
    );
    const requiredColumns = [
      "id",
      "rollout_path",
      "created_at",
      "updated_at",
      "source",
      "model_provider",
      "cwd",
      "title",
      "sandbox_policy",
      "approval_mode",
    ];
    if (!requiredColumns.every((column) => columns.has(column))) return;

    const firstUserMessage = session.messages.find((message) => message.role === "user")?.content ?? "";
    const title = session.title || firstUserMessage || "Migrated session";
    const createdAtMs = timestampMs(session.startedAt);
    const updatedAtMs = now.getTime();
    const createdAt = Math.floor(createdAtMs / 1000);
    const updatedAt = Math.floor(updatedAtMs / 1000);
    const rolloutPath = path.toNamespacedPath(path.resolve(filePath));
    const cwd = path.toNamespacedPath(path.resolve(session.projectPath));
    const existing = db.prepare("SELECT * FROM threads WHERE id = ?").get(sessionId) as Record<string, unknown> | undefined;
    const template = existing ?? db.prepare("SELECT * FROM threads ORDER BY updated_at_ms DESC, updated_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    const values: Record<string, unknown> = {
      id: sessionId,
      rollout_path: rolloutPath,
      created_at: existing?.created_at ?? createdAt,
      updated_at: updatedAt,
      source: "vscode",
      model_provider: requiredRuntimeValue(runtimeMetadata.codexModelProvider, "Codex model provider"),
      cwd,
      title,
      sandbox_policy: existing?.sandbox_policy ?? template?.sandbox_policy ?? "{}",
      approval_mode: existing?.approval_mode ?? template?.approval_mode ?? "on-request",
      tokens_used: existing?.tokens_used ?? 0,
      has_user_event: 1,
      archived: existing?.archived ?? 0,
      cli_version: "migration",
      first_user_message: firstUserMessage,
      memory_mode: existing?.memory_mode ?? template?.memory_mode ?? "enabled",
      model: existing?.model ?? template?.model ?? null,
      reasoning_effort: existing?.reasoning_effort ?? template?.reasoning_effort ?? null,
      agent_path: existing?.agent_path ?? template?.agent_path ?? null,
      created_at_ms: existing?.created_at_ms ?? createdAtMs,
      updated_at_ms: updatedAtMs,
      thread_source: "user",
      preview: title,
      recency_at: updatedAt,
      recency_at_ms: updatedAtMs,
      history_mode: "legacy",
    };

    if (existing) {
      const updates = Object.keys(values).filter((column) => column !== "id" && columns.has(column));
      const assignments = updates.map((column) => `${column} = ?`).join(", ");
      db.prepare(`UPDATE threads SET ${assignments} WHERE id = ?`).run(
        ...(updates.map((column) => values[column]) as import("node:sqlite").SQLInputValue[]),
        sessionId,
      );
      return;
    }

    const insertColumns = Object.keys(values).filter((column) => columns.has(column));
    const placeholders = insertColumns.map(() => "?").join(", ");
    db.prepare(`INSERT INTO threads (${insertColumns.join(", ")}) VALUES (${placeholders})`).run(
      ...(insertColumns.map((column) => values[column]) as import("node:sqlite").SQLInputValue[]),
    );
  } catch {
    // The Codex app-server may hold the state database open. The rollout file
    // and native session index remain authoritative when this best-effort
    // display registration cannot acquire the database.
  } finally {
    db?.close();
  }
}

function findCodexStateDatabase(targetHome: string): string | null {
  try {
    const candidates = fs.readdirSync(targetHome, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name))
      .map((entry) => path.join(targetHome, entry.name));
    candidates.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

function readCodexSessionIndex(indexPath: string): unknown[] {
  let content: string;
  try {
    content = fs.readFileSync(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const rows: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error("contains invalid JSONL");
    }
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonlStrict(filePath: string, target: MigrationTarget): unknown[] {
  const rows: unknown[] = [];
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      failValidation(target, "contains invalid JSONL");
    }
  }
  return rows;
}

function validateNativeStructure(
  target: MigrationTarget,
  rows: unknown[],
  sessionId: string,
  session: PortableSession,
  runtimeMetadata: MigrationTargetRuntimeMetadata,
): void {
  const family = migrationTargetDescriptor(target).family;
  if (family === "codex") {
    validateCodexStructure(
      rows,
      sessionId,
      session,
      requiredRuntimeValue(runtimeMetadata.codexModelProvider, "Codex model provider"),
      target === "codex" && process.platform === "win32",
    );
  } else if (family === "claude") {
    validateClaudeStructure(rows, sessionId, session, requiredRuntimeValue(runtimeMetadata.claudeModel, "Claude model"));
  } else if (target === "cursor") {
    validateCursorStructure(rows, session);
  } else {
    validateCodeBuddyStructure(rows, sessionId, session);
  }
}

function validateCodexStructure(
  rows: unknown[],
  sessionId: string,
  session: PortableSession,
  modelProvider: string,
  includeVsCodeEvents: boolean,
): void {
  const expectedRows = 1 + session.messages.length * (includeVsCodeEvents ? 2 : 1) + (includeVsCodeEvents ? 1 : 0);
  if (rows.length !== expectedRows) failValidation("codex", "has an unexpected row count");
  const meta = record(rows[0]);
  const payload = record(meta?.payload);
  if (
    meta?.type !== "session_meta"
    || meta.timestamp !== session.startedAt
    || payload?.id !== sessionId
    || payload.title !== session.title
    || payload.cwd !== session.projectPath
    || payload.model_provider !== modelProvider
    || (includeVsCodeEvents && (
      payload.session_id !== sessionId
      || payload.source !== "vscode"
      || payload.thread_source !== "user"
      || payload.history_mode !== "legacy"
    ))
  ) {
    failValidation("codex", "has invalid session metadata");
  }

  let rowIndex = 1;
  if (includeVsCodeEvents) {
    const taskStarted = record(rows[rowIndex++]);
    const taskPayload = record(taskStarted?.payload);
    if (
      taskStarted?.type !== "event_msg"
      || taskPayload?.type !== "task_started"
      || taskPayload.turn_id !== sessionId
    ) {
      failValidation("codex", "has invalid app-server task metadata");
    }
  }

  session.messages.forEach((message) => {
    const row = record(rows[rowIndex++]);
    const messagePayload = record(row?.payload);
    const content = Array.isArray(messagePayload?.content) ? messagePayload.content : [];
    const block = record(content[0]);
    const expectedBlockType = message.role === "user" ? "input_text" : "output_text";
    if (
      row?.type !== "response_item"
      || row.timestamp !== message.timestamp
      || messagePayload?.type !== "message"
      || messagePayload.role !== message.role
      || content.length !== 1
      || block?.type !== expectedBlockType
      || block.text !== message.content
    ) {
      failValidation("codex", `has invalid message structure at index ${rowIndex}`);
    }
    if (includeVsCodeEvents) {
      const event = record(rows[rowIndex++]);
      const eventPayload = record(event?.payload);
      const expectedEventType = message.role === "user" ? "user_message" : "agent_message";
      if (
        event?.type !== "event_msg"
        || eventPayload?.type !== expectedEventType
        || eventPayload.message !== message.content
      ) {
        failValidation("codex", `has invalid app-server message event at index ${rowIndex}`);
      }
    }
  });
}

function validateClaudeStructure(rows: unknown[], sessionId: string, session: PortableSession, model: string): void {
  if (rows.length !== session.messages.length + 1) failValidation("claude", "has an unexpected row count");
  const title = record(rows[0]);
  if (title?.type !== "ai-title" || title.aiTitle !== session.title || title.sessionId !== sessionId) {
    failValidation("claude", "has invalid title metadata");
  }

  const seenIds = new Set<string>();
  let parentUuid: string | null = null;
  session.messages.forEach((portableMessage, index) => {
    const row = record(rows[index + 1]);
    const message = record(row?.message);
    const uuid = typeof row?.uuid === "string" ? row.uuid : "";
    if (!UUID_PATTERN.test(uuid) || seenIds.has(uuid)) failValidation("claude", `has invalid message UUID at index ${index}`);
    seenIds.add(uuid);

    const contentMatches = portableMessage.role === "user"
      ? message?.content === portableMessage.content
      : textBlockMatches(message?.content, "text", portableMessage.content);
    if (
      row?.parentUuid !== parentUuid
      || row.type !== portableMessage.role
      || row.timestamp !== portableMessage.timestamp
      || row.cwd !== session.projectPath
      || row.sessionId !== sessionId
      || message?.role !== portableMessage.role
      || (portableMessage.role === "assistant" && message.model !== model)
      || !contentMatches
    ) {
      failValidation("claude", `has invalid message structure at index ${index}`);
    }
    parentUuid = uuid;
  });
}

function requiredRuntimeValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} was not resolved for session migration.`);
  return value;
}

function validateCodeBuddyStructure(rows: unknown[], sessionId: string, session: PortableSession): void {
  if (rows.length !== session.messages.length + 1) failValidation("codebuddy", "has an unexpected row count");
  const title = record(rows[0]);
  if (
    title?.type !== "ai-title"
    || title.aiTitle !== session.title
    || title.sessionId !== sessionId
    || title.cwd !== session.projectPath
    || title.timestamp !== timestampMs(session.startedAt)
  ) {
    failValidation("codebuddy", "has invalid title metadata");
  }

  const seenIds = new Set<string>();
  let parentId: string | undefined;
  session.messages.forEach((message, index) => {
    const row = record(rows[index + 1]);
    if (!row) failValidation("codebuddy", `has invalid message structure at index ${index}`);
    const id = typeof row.id === "string" ? row.id : "";
    const expectedBlockType = message.role === "user" ? "input_text" : "output_text";
    if (!id || seenIds.has(id)) failValidation("codebuddy", `has invalid message id at index ${index}`);
    seenIds.add(id);
    if (
      row?.parentId !== parentId
      || row.timestamp !== timestampMs(message.timestamp)
      || row.type !== "message"
      || row.role !== message.role
      || row.sessionId !== sessionId
      || row.cwd !== session.projectPath
      || !textBlockMatches(row.content, expectedBlockType, message.content)
    ) {
      failValidation("codebuddy", `has invalid message structure at index ${index}`);
    }
    parentId = id;
  });
}

function validateCursorStructure(rows: unknown[], session: PortableSession): void {
  if (rows.length !== session.messages.length) failValidation("cursor", "has an unexpected row count");

  session.messages.forEach((message, index) => {
    const row = record(rows[index]);
    const nested = record(row?.message);
    const content = Array.isArray(nested?.content) ? nested.content : [];
    const block = record(content[0]);
    const text = typeof block?.text === "string" ? block.text : "";
    const expectedContent = normalizeCursorMigrationContent(message.content, message.role);
    const contentMatches = message.role === "user"
      ? extractCursorUserQuery(text) === expectedContent
      : text === expectedContent;
    if (
      row?.role !== message.role
      || content.length !== 1
      || block?.type !== "text"
      || !contentMatches
    ) {
      failValidation("cursor", `has invalid message structure at index ${index}`);
    }
  });
}

function textBlockMatches(content: unknown, type: string, text: string): boolean {
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block = record(content[0]);
  return block?.type === type && block.text === text;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function failValidation(target: MigrationTarget, detail: string): never {
  throw new Error(`Migrated ${target} session failed validation: ${detail}.`);
}

function loadWrittenSession(
  target: MigrationTarget,
  filePath: string,
  sessionId: string,
  session: PortableSession,
): LoadedSession | null {
  if (target === "cursor") {
    const { workspaceSlug } = parseCursorTranscriptPath(filePath);
    const workspacePathMap = workspaceSlug
      ? new Map([[workspaceSlug, session.projectPath]])
      : undefined;
    return loadCursorTranscriptFile(filePath, undefined, workspacePathMap);
  }

  const descriptor = migrationTargetDescriptor(target);
  if (descriptor.family === "codewiz") {
    return loadCodeWizSessions(path.dirname(filePath)).find((item) => item.session.rawId === sessionId) ?? null;
  }
  const rows = parseJsonlText(fs.readFileSync(filePath, "utf8"));
  if (descriptor.family === "codex") {
    return loadCodexSessionRows(filePath, rows, { sourceOverride: descriptor.source });
  }
  if (descriptor.family === "codebuddy") return loadCodeBuddyCliSessionFile(filePath);
  return loadClaudeCliSessionRows(filePath, rows, {
    rawId: sessionId,
    cwd: session.projectPath,
    startedAt: new Date(session.startedAt).getTime(),
    source: descriptor.source,
  });
}

function validateRoundTrip(
  loaded: LoadedSession | null,
  target: MigrationTarget,
  sessionId: string,
  portable: PortableSession,
): void {
  const descriptor = migrationTargetDescriptor(target);
  const messagesMatch = loaded?.messages.length === portable.messages.length
    && loaded.messages.every((message, index) => {
      const expected = portable.messages[index];
      const expectedContent = target === "cursor"
        ? normalizeCursorMigrationContent(expected.content, expected.role)
        : expected.content;
      const timestampMatches = descriptor.family === "codebuddy" || descriptor.family === "codewiz"
        ? new Date(message.timestamp).getTime() === new Date(expected.timestamp).getTime()
        : target === "cursor"
          ? true
          : message.timestamp === expected.timestamp;
      return message.role === expected.role
        && message.content === expectedContent
        && timestampMatches;
    });

  const titleOk = target === "cursor"
    ? Boolean(loaded && titleMatches(loaded, target, portable))
    : loaded?.session.originalTitle === portable.title;

  if (
    !loaded
    || loaded.session.source !== descriptor.source
    || loaded.session.rawId !== sessionId
    || loaded.session.projectPath !== portable.projectPath
    || !titleOk
    || !messagesMatch
  ) {
    failValidation(target, "round-trip data does not match the portable session");
  }
}

function titleMatches(loaded: LoadedSession, target: MigrationTarget, portable: PortableSession): boolean {
  if (target === "cursor") {
    const firstUser = normalizeCursorMigrationContent(
      portable.messages.find((message) => message.role === "user")?.content || "",
      "user",
    );
    return cleanTitle(loaded.session.firstQuestion) === cleanTitle(firstUser)
      || loaded.session.originalTitle === portable.title;
  }
  return loaded.session.originalTitle === portable.title;
}
