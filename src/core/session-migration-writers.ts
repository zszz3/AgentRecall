import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadClaudeCliSessionRows,
  loadCodeBuddyCliSessionFile,
  loadCodexSessionFile,
  parseJsonlText,
} from "./session-loader";
import type { LoadedSession, MigrationAgent, PortableSession } from "./types";

export interface WriteMigratedSessionOptions {
  target: MigrationAgent;
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
  const filePath = targetFilePath(options.target, options.session.projectPath, sessionId, homeDir, now);
  const rows = serializeSession(options.target, options.session, sessionId, createId);
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeJsonlAndSync(tempPath, rows);
    if (options.beforeValidate) await options.beforeValidate(tempPath);
    const writtenRows = readJsonlStrict(tempPath, options.target);
    validateNativeStructure(options.target, writtenRows, sessionId, options.session);
    const loaded = loadWrittenSession(options.target, tempPath, sessionId, options.session);
    validateRoundTrip(loaded, options.target, sessionId, options.session);
    if (options.validate) {
      const additionallyLoaded = await options.validate(tempPath);
      validateRoundTrip(additionallyLoaded, options.target, sessionId, options.session);
    }
    await fs.promises.chmod(tempPath, 0o600);
    if (options.rename) await options.rename(tempPath, filePath);
    else await fs.promises.rename(tempPath, filePath);
    return { sessionId, filePath };
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}

function serializeSession(
  target: MigrationAgent,
  session: PortableSession,
  sessionId: string,
  createId: () => string,
): unknown[] {
  if (target === "codex") return serializeCodex(session, sessionId);
  if (target === "claude") return serializeClaude(session, sessionId, createId);
  return serializeCodeBuddy(session, sessionId, createId);
}

function serializeCodex(session: PortableSession, sessionId: string): unknown[] {
  return [
    {
      type: "session_meta",
      timestamp: session.startedAt,
      payload: {
        id: sessionId,
        timestamp: session.startedAt,
        cwd: session.projectPath,
        title: session.title,
        originator: "agent-session-search",
        cli_version: "migration",
      },
    },
    ...session.messages.map((message) => ({
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
    })),
  ];
}

function serializeClaude(
  session: PortableSession,
  sessionId: string,
  createId: () => string,
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
          model: "session-migration",
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

export function targetFilePath(
  target: MigrationAgent,
  projectPath: string,
  sessionId: string,
  homeDir: string,
  now: Date,
): string {
  if (target === "codex") {
    const year = String(now.getUTCFullYear()).padStart(4, "0");
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    const safeTimestamp = now.toISOString().replace(/[:.]/g, "-");
    return path.join(homeDir, ".codex", "sessions", year, month, day, `rollout-${safeTimestamp}-${sessionId}.jsonl`);
  }

  if (target === "claude") {
    return path.join(homeDir, ".claude", "projects", encodeClaudeProjectDir(projectPath), `${sessionId}.jsonl`);
  }

  return path.join(homeDir, ".codebuddy", "projects", encodeCodeBuddyProjectDir(projectPath), `${sessionId}.jsonl`);
}

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

function readJsonlStrict(filePath: string, target: MigrationAgent): unknown[] {
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
  target: MigrationAgent,
  rows: unknown[],
  sessionId: string,
  session: PortableSession,
): void {
  if (target === "codex") {
    validateCodexStructure(rows, sessionId, session);
  } else if (target === "claude") {
    validateClaudeStructure(rows, sessionId, session);
  } else {
    validateCodeBuddyStructure(rows, sessionId, session);
  }
}

function validateCodexStructure(rows: unknown[], sessionId: string, session: PortableSession): void {
  if (rows.length !== session.messages.length + 1) failValidation("codex", "has an unexpected row count");
  const meta = record(rows[0]);
  const payload = record(meta?.payload);
  if (
    meta?.type !== "session_meta"
    || meta.timestamp !== session.startedAt
    || payload?.id !== sessionId
    || payload.title !== session.title
    || payload.cwd !== session.projectPath
  ) {
    failValidation("codex", "has invalid session metadata");
  }

  session.messages.forEach((message, index) => {
    const row = record(rows[index + 1]);
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
      failValidation("codex", `has invalid message structure at index ${index}`);
    }
  });
}

function validateClaudeStructure(rows: unknown[], sessionId: string, session: PortableSession): void {
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
      || !contentMatches
    ) {
      failValidation("claude", `has invalid message structure at index ${index}`);
    }
    parentUuid = uuid;
  });
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

function failValidation(target: MigrationAgent, detail: string): never {
  throw new Error(`Migrated ${target} session failed validation: ${detail}.`);
}

function loadWrittenSession(
  target: MigrationAgent,
  filePath: string,
  sessionId: string,
  session: PortableSession,
): LoadedSession | null {
  if (target === "codex") return loadCodexSessionFile(filePath);
  if (target === "codebuddy") return loadCodeBuddyCliSessionFile(filePath);

  const rows = parseJsonlText(fs.readFileSync(filePath, "utf8"));
  return loadClaudeCliSessionRows(filePath, rows, {
    rawId: sessionId,
    cwd: session.projectPath,
    startedAt: new Date(session.startedAt).getTime(),
  });
}

function validateRoundTrip(
  loaded: LoadedSession | null,
  target: MigrationAgent,
  sessionId: string,
  portable: PortableSession,
): void {
  const expectedSource = target === "codex" ? "codex-cli" : target === "claude" ? "claude-cli" : "codebuddy-cli";
  const messagesMatch = loaded?.messages.length === portable.messages.length
    && loaded.messages.every((message, index) => {
      const expected = portable.messages[index];
      const timestampMatches = target === "codebuddy"
        ? new Date(message.timestamp).getTime() === new Date(expected.timestamp).getTime()
        : message.timestamp === expected.timestamp;
      return message.role === expected.role
        && message.content === expected.content
        && timestampMatches;
    });

  if (
    !loaded
    || loaded.session.source !== expectedSource
    || loaded.session.rawId !== sessionId
    || loaded.session.projectPath !== portable.projectPath
    || loaded.session.originalTitle !== portable.title
    || !messagesMatch
  ) {
    failValidation(target, "round-trip data does not match the portable session");
  }
}
