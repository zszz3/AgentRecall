import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanTitle, extractCursorUserQuery } from "./format-adapters";
import {
  encodeCursorWorkspaceSlug,
  loadClaudeCliSessionRows,
  loadCodeBuddyCliSessionFile,
  loadCodexSessionRows,
  loadCursorTranscriptFile,
  parseCursorTranscriptPath,
  parseJsonlText,
} from "./session-loader";
import { migrationTargetDescriptor } from "./migration-targets";
import type { LoadedSession, MigrationTarget, PortableSession } from "./types";

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
  target: MigrationTarget,
  session: PortableSession,
  sessionId: string,
  createId: () => string,
): unknown[] {
  if (target === "cursor") return serializeCursor(session);
  const family = migrationTargetDescriptor(target).family;
  if (family === "codex") return serializeCodex(session, sessionId, codexModelProvider(target));
  if (family === "claude") return serializeClaude(session, sessionId, createId);
  return serializeCodeBuddy(session, sessionId, createId);
}

function serializeCodex(session: PortableSession, sessionId: string, modelProvider: string): unknown[] {
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
        model_provider: modelProvider,
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

function codexModelProvider(target: MigrationTarget): string {
  if (target === "tcodex") return "tencent";
  if (target === "codex-internal") return "codebuddy";
  return "openai";
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
): void {
  const family = migrationTargetDescriptor(target).family;
  if (family === "codex") {
    validateCodexStructure(rows, sessionId, session);
  } else if (family === "claude") {
    validateClaudeStructure(rows, sessionId, session);
  } else if (target === "cursor") {
    validateCursorStructure(rows, session);
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
      const timestampMatches = descriptor.family === "codebuddy"
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
