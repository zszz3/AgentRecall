/**
 * DeepSeek Harness (dsh) session log parsing.
 *
 * The harness persists each session as `~/.dsh/sessions/<project-key>/<session-id>/session.jsonl.zstd`:
 * a concatenated stream of Zstandard frames whose decompressed payload is a JSONL
 * event log. The first record is a `session` header line; every following record is
 * a {@link SessionEvent} envelope `{ type, seq, time, data }` per
 * deepseek-harness `@deepseek-ai/dsh-session` (SESSION_FORMAT_VERSION 0).
 *
 * Files are append-only and may be written while we read them, so we mirror the
 * harness's own `scanZstdFrames`: walk complete frames structurally, decompress
 * each with the built-in `node:zlib` zstd API (no third-party dependency), and
 * stop at a torn tail instead of failing the whole session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { isMeaningfulUserMessage } from "./format-adapters";
import type { SessionFormat, SessionMessage, SessionTraceEvent, TokenUsageEvent } from "./types";

const ZSTD_MAGIC = 0xfd2fb528;

export const DEEPSEEK_HARNESS_DIR = ".dsh";
export const DEEPSEEK_HARNESS_LOG_NAME = "session.jsonl.zstd";

/** Structural scan result for a concatenated Zstandard stream. */
export interface DeepSeekZstdFrame {
  /** Inclusive frame start. */
  start: number;
  /** Exclusive frame end. */
  end: number;
}

/**
 * Locate complete Zstandard frames without decompressing their blocks. Invalid
 * complete structure rejects; EOF inside the final frame returns what was
 * found so far. Mirrors deepseek-harness `scanZstdFrames`.
 */
export function scanDeepSeekZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): DeepSeekZstdFrame[] {
  const frames: DeepSeekZstdFrame[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return frames;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt DeepSeek Harness session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === buffer.length) return frames;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt DeepSeek Harness session log: reserved frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return frames;
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt DeepSeek Harness session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return frames;
  }

  return frames;
}

/** Decompress a structurally complete Zstandard frame into UTF-8 text. */
export function decompressDeepSeekZstdFrame(buffer: Buffer, frame: DeepSeekZstdFrame): string {
  return zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8");
}

export interface DeepSeekSessionHeader {
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  delegationDepth: number;
  agentPreset?: string;
}

export interface DeepSeekSessionEvent {
  type: string;
  seq: number;
  time: number;
  data?: unknown;
  sourceEventSeqs?: number[];
  surfaceOp?: unknown;
  ignorable?: true;
}

export interface DeepSeekSessionLog {
  header: DeepSeekSessionHeader;
  events: DeepSeekSessionEvent[];
  /** Byte offset up to which the log is complete; a torn tail was dropped. */
  committedBytes: number;
}

function parseDeepSeekJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parseDeepSeekHeader(raw: unknown): DeepSeekSessionHeader | null {
  if (!raw || typeof raw !== "object") return null;
  const line = raw as Record<string, unknown>;
  if (line.type !== "session") return null;
  const id = typeof line.id === "string" ? line.id : "";
  if (!id || !Number.isSafeInteger(line.createdAt)) return null;
  return {
    version: typeof line.version === "number" ? line.version : 0,
    id,
    createdAt: line.createdAt as number,
    ...(typeof line.cwd === "string" ? { cwd: line.cwd } : {}),
    ...(typeof line.parentSession === "string" ? { parentSession: line.parentSession } : {}),
    delegationDepth: typeof line.delegationDepth === "number" ? line.delegationDepth : 0,
    ...(typeof line.agentPreset === "string" ? { agentPreset: line.agentPreset } : {}),
  };
}

function parseDeepSeekEvent(raw: unknown): DeepSeekSessionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const line = raw as Record<string, unknown>;
  if (typeof line.type !== "string") return null;
  const seq = line.seq;
  const time = line.time;
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(time)) return null;
  return {
    type: line.type,
    seq: seq as number,
    time: time as number,
    data: line.data,
    ...(Array.isArray(line.sourceEventSeqs) ? { sourceEventSeqs: line.sourceEventSeqs as number[] } : {}),
    ...(line.surfaceOp !== undefined ? { surfaceOp: line.surfaceOp } : {}),
    ...(line.ignorable === true ? { ignorable: true } : {}),
  };
}


/**
 * Storage-row packing: runs of consecutive same-block delta chunks are packed
 * into ONE row — `text-chunks` / `reasoning-chunks` / `tool-call-chunks`.
 * Rows are a durable-encoding vocabulary, NOT session events: they carry
 * `seq0`/`time0` anchors plus member payloads and must be expanded back into
 * individual `assistant/chunk` events before the transcript is usable.
 * Mirrors deepseek-harness `decodeStorageRecord`.
 */
function expandDeepSeekChunkRow(raw: Record<string, unknown>): DeepSeekSessionEvent[] | null {
  const type = raw.type;
  if (type !== "text-chunks" && type !== "reasoning-chunks" && type !== "tool-call-chunks") return null;
  const seq0 = raw.seq0;
  const time0 = raw.time0;
  if (!Number.isSafeInteger(seq0) || !Number.isSafeInteger(time0)) return null;
  const data = raw.data && typeof raw.data === "object" ? raw.data as Record<string, unknown> : null;
  if (!data) return null;
  const payloadKey = type === "tool-call-chunks" ? "args" : "texts";
  const payload = data[payloadKey];
  if (!Array.isArray(payload) || payload.length === 0 || payload.some((entry) => typeof entry !== "string")) return null;
  const dt = data.dt;
  if (!Array.isArray(dt) || dt.some((gap) => !Number.isSafeInteger(gap)) || dt.length !== payload.length - 1) return null;

  const events: DeepSeekSessionEvent[] = [];
  let time = time0 as number;
  for (let k = 0; k < payload.length; k++) {
    if (k > 0) time += dt[k - 1] as number;
    let chunk: Record<string, unknown>;
    if (type === "tool-call-chunks") {
      chunk = {
        type: "tool-call-delta",
        index: data.index,
        id: data.id,
        ...(typeof data.name === "string" ? { name: data.name } : {}),
        argumentsDelta: payload[k],
      };
    } else {
      chunk = {
        type: type === "text-chunks" ? "text-delta" : "reasoning-delta",
        index: data.index,
        text: payload[k],
      };
    }
    events.push({
      type: "assistant/chunk",
      seq: (seq0 as number) + k,
      time,
      data: { turn: data.turn, step: data.step, chunk },
    });
  }
  return events;
}

/**
 * Decompress a complete (possibly torn) log buffer into its header and event
 * prefix. Each frame decodes independently; a frame that fails to decompress
 * or starts mid-record ends the scan, so a concurrent append never corrupts
 * previously committed history.
 */
export function parseDeepSeekSessionLog(buffer: Buffer, logPath = ""): DeepSeekSessionLog | null {
  let frames: DeepSeekZstdFrame[];
  try {
    frames = scanDeepSeekZstdFrames(buffer);
  } catch {
    return null;
  }
  if (frames.length === 0) return null;

  let header: DeepSeekSessionHeader | null = null;
  const events: DeepSeekSessionEvent[] = [];
  let committedBytes = 0;

  for (const frame of frames) {
    let text: string;
    try {
      text = decompressDeepSeekZstdFrame(buffer, frame);
    } catch {
      break;
    }
    const completeFrameText = text.endsWith("\n");
    let end = text.length;
    if (!completeFrameText) {
      // A final partial record crossing frames is a torn tail of an active
      // append. Everything up to the previous newline is already durable.
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) break;
      end = lastNewline + 1;
    }
    let contiguous = true;
    for (const line of text.slice(0, end).split("\n")) {
      const parsed = parseDeepSeekJsonLine(line);
      if (parsed === undefined) continue;
      if (!header) {
        header = parseDeepSeekHeader(parsed);
        if (!header) throw new Error(`corrupt session log: first record is not a session header${logPath ? ` (${logPath})` : ""}`);
        continue;
      }
      const parsedRecord = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      const expanded = parsedRecord ? expandDeepSeekChunkRow(parsedRecord) : null;
      if (expanded) {
        // A packed chunk run: all members must follow the previous seq exactly.
        const rowStart = events.length;
        for (const chunkEvent of expanded) {
          if (chunkEvent.seq !== events.length) {
            events.length = rowStart;
            contiguous = false;
            break;
          }
          events.push(chunkEvent);
        }
        if (!contiguous) break;
        continue;
      }
      const event = parseDeepSeekEvent(parsed);
      if (!event) continue;
      if (event.seq !== events.length) {
        contiguous = false;
        break;
      }
      events.push(event);
    }
    if (!contiguous || !completeFrameText) break;
    committedBytes = frame.end;
  }

  if (!header) return null;
  return { header, events, committedBytes };
}

function deepSeekRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

/** First text block of a content array, plus a marker when a leading image was dropped. */
function deepSeekText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  let imageDropped = false;
  for (const item of content) {
    const block = deepSeekRecord(item);
    if (!block) continue;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text") {
      if (typeof block.text === "string" && block.text) texts.push(block.text);
    } else if (type === "image") {
      imageDropped = true;
    }
  }
  const text = texts.join("\n");
  if (!text && imageDropped) return "[Attachment]";
  return text;
}

function deepSeekEventTimeMs(event: DeepSeekSessionEvent): number {
  return Number.isFinite(event.time) ? event.time : 0;
}

/** Latest `session/title` payload, folded last-write-wins like the harness. */
function deepSeekTitle(events: DeepSeekSessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "session/title") continue;
    const data = deepSeekRecord(event.data);
    const title = data ? data.title : null;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return "";
}

interface DeepSeekUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  cacheWriteTokens: number;
}

function normalizeDeepSeekUsage(value: unknown): DeepSeekUsage | null {
  const usage = deepSeekRecord(value);
  if (!usage) return null;
  const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const outputTokens = number(usage.outputTokens);
  const reasoningTokens = number(usage.reasoningTokens);
  // Harness output already includes reasoning; AgentRecall stores disjoint buckets.
  return {
    inputTokens: number(usage.inputTokens),
    outputTokens: Math.max(0, outputTokens - reasoningTokens),
    cacheReadTokens: number(usage.cacheReadTokens),
    reasoningTokens,
    cacheWriteTokens: number(usage.cacheWriteTokens),
  };
}

function deepSeekUsageOfEvent(event: DeepSeekSessionEvent): { turn: number; step: number; usage: DeepSeekUsage } | null {
  const data = deepSeekRecord(event.data);
  if (data === null) return null;
  if (event.type === "assistant/message") {
    const usage = normalizeDeepSeekUsage(data.usage);
    if (usage === null) return null;
    return { turn: deepSeekNumber(data.turn), step: deepSeekNumber(data.step), usage };
  }
  if (event.type === "assistant/chunk") {
    const chunk = deepSeekRecord(data.chunk);
    if (chunk === null || chunk.type !== "usage") return null;
    const usage = normalizeDeepSeekUsage(chunk.usage);
    if (usage === null) return null;
    return {
      turn: deepSeekNumber(data.turn),
      step: deepSeekNumber(data.step),
      usage,
    };
  }
  return null;
}

function deepSeekNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

/**
 * Token usage fold that mirrors deepseek-harness tokenUsageProjection:
 * usage samples for the same turn/step replace each other (last wins) instead
 * of double counting, while later turn/step samples accumulate independently.
 */
interface DeepSeekUsageFold {
  usage: DeepSeekUsage;
  tokenEvents: TokenUsageEvent[];
}

function deepSeekTotalUsage(events: DeepSeekSessionEvent[], sessionId: string): DeepSeekUsageFold {
  const totals: DeepSeekUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 };
  const tokenEvents: TokenUsageEvent[] = [];
  let last: { turn: number; step: number; usage: DeepSeekUsage } | null = null;
  for (const event of events) {
    const sample = deepSeekUsageOfEvent(event);
    if (sample === null || sample.turn < 0 || sample.step < 0) continue;
    const dedupeKey = `deepseek:${sessionId}:${sample.turn}:${sample.step}`;
    if (last !== null && last.turn === sample.turn && last.step === sample.step) {
      if (
        last.usage.inputTokens === sample.usage.inputTokens
        && last.usage.outputTokens === sample.usage.outputTokens
        && last.usage.cacheReadTokens === sample.usage.cacheReadTokens
        && last.usage.reasoningTokens === sample.usage.reasoningTokens
        && last.usage.cacheWriteTokens === sample.usage.cacheWriteTokens
      ) continue;
      totals.inputTokens -= last.usage.inputTokens;
      totals.outputTokens -= last.usage.outputTokens;
      totals.cacheReadTokens -= last.usage.cacheReadTokens;
      totals.reasoningTokens -= last.usage.reasoningTokens;
      totals.cacheWriteTokens -= last.usage.cacheWriteTokens;
      tokenEvents.pop();
    }
    totals.inputTokens += sample.usage.inputTokens;
    totals.outputTokens += sample.usage.outputTokens;
    totals.cacheReadTokens += sample.usage.cacheReadTokens;
    totals.reasoningTokens += sample.usage.reasoningTokens;
    totals.cacheWriteTokens += sample.usage.cacheWriteTokens;
    tokenEvents.push({
      inputTokens: sample.usage.inputTokens,
      outputTokens: sample.usage.outputTokens,
      cachedInputTokens: sample.usage.cacheReadTokens,
      ...(sample.usage.cacheWriteTokens > 0
        ? { cacheCreationInputTokens: sample.usage.cacheWriteTokens }
        : {}),
      reasoningOutputTokens: sample.usage.reasoningTokens,
      totalTokens: sample.usage.inputTokens
        + sample.usage.outputTokens
        + sample.usage.cacheReadTokens
        + sample.usage.cacheWriteTokens
        + sample.usage.reasoningTokens,
      timestamp: deepSeekEventTimeMs(event),
      dedupeKey,
    });
    last = sample;
  }
  return { usage: totals, tokenEvents };
}

function deepSeekSourceKind(event: DeepSeekSessionEvent): string {
  const message = deepSeekRecord(event.data) ?? deepSeekRecord(deepSeekRecord(event.data)?.message);
  const source = deepSeekRecord(message?.source);
  return typeof source?.kind === "string" ? source.kind : "";
}

function deepSeekTimestampOf(event: DeepSeekSessionEvent, iso: string | undefined): string {
  const ms = deepSeekEventTimeMs(event);
  if (!ms) return "";
  if (typeof iso === "string" && iso) return iso;
  return new Date(ms).toISOString();
}

function deepSeekToolArguments(event: DeepSeekSessionEvent): string {
  const data = deepSeekRecord(event.data);
  if (!data) return "";
  if (typeof data.arguments === "string") return data.arguments;
  return "";
}

function deepSeekSessionMessages(log: DeepSeekSessionLog): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (const event of log.events) {
    if (event.type === "user/message") {
      const data = deepSeekRecord(event.data);
      if (!data) continue;
      // The harness's surface distinguishes human prompts (`source.kind ===
      // "user"`) from injected context and goal continuations, all of which
      // project into the user role. Only real prompts become transcript
      // messages; injected context would otherwise dominate search results.
      const kind = deepSeekSourceKind(event);
      if (kind && kind !== "user") continue;
      const content = deepSeekText(data.content);
      if (!content || !isMeaningfulUserMessage(content)) continue;
      messages.push({
        role: "user",
        content,
        timestamp: deepSeekTimestampOf(event, typeof data.timestamp === "string" ? data.timestamp : undefined),
        index: messages.length,
      });
    } else if (event.type === "assistant/message") {
      const data = deepSeekRecord(event.data);
      const message = deepSeekRecord(data?.message);
      if (!message) continue;
      const content = deepSeekText(message.content);
      if (!content) continue;
      messages.push({
        role: "assistant",
        content,
        timestamp: deepSeekTimestampOf(event, typeof message.timestamp === "string" ? message.timestamp : undefined),
        index: messages.length,
      });
    }
  }
  return messages;
}

function deepSeekToolResultBlock(value: unknown): { callId: string; isError: boolean; text: string } | null {
  const message = deepSeekRecord(value);
  if (message === null) return null;
  const source = deepSeekRecord(message.source);
  const callId = typeof source?.callId === "string" ? source.callId : "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  let isError = false;
  let text = "";
  for (const item of blocks) {
    const block = deepSeekRecord(item);
    if (block === null || block.type !== "tool-result") continue;
    if (block.isError === true) isError = true;
    const nested = Array.isArray(block.content) ? block.content : [];
    const nestedText = deepSeekText(nested);
    if (nestedText) text = text ? text + "\n" + nestedText : nestedText;
  }
  return { callId, isError, text };
}

function deepSeekSessionTraceEvents(log: DeepSeekSessionLog, source: SessionFormat): SessionTraceEvent[] {
  const events: SessionTraceEvent[] = [];
  const results = new Map<string, { status: "completed" | "failed"; detail: string }>();
  for (const event of log.events) {
    if (event.type === "tool/call") {
      const data = deepSeekRecord(event.data);
      const name = typeof data?.name === "string" && data.name ? data.name : "tool";
      const callId = typeof data?.callId === "string" ? data.callId : "";
      const argumentsText = deepSeekToolArguments(event);
      const detail = name === "bash"
        ? argumentsText
        : argumentsText
          ? (() => {
              try {
                return JSON.stringify(JSON.parse(argumentsText), null, 2);
              } catch {
                return argumentsText;
              }
            })()
          : "";
      events.push({
        index: events.length,
        kind: "tool_call",
        source,
        title: name,
        detail,
        timestamp: deepSeekTimestampOf(event, undefined),
        callId: callId || null,
        eventType: null,
        status: null,
      });
    } else if (event.type === "tool/result") {
      const data = deepSeekRecord(event.data);
      const block = deepSeekToolResultBlock(data?.message);
      const callId = (block !== null && block.callId) || (typeof data?.callId === "string" ? data.callId : "");
      const failed = (block !== null && block.isError) || data?.isError === true || Boolean(data?.error);
      results.set(callId, {
        status: failed ? "failed" : "completed",
        detail: block?.text ?? "",
      });
    }
  }
  // Attach result facts to their call so the detail pane pairs them.
  for (const event of events) {
    if (!event.callId) continue;
    const result = results.get(event.callId);
    if (!result) continue;
    event.status = result.status;
    if (result.detail) event.detail = event.detail ? `${event.detail}\n\n${result.detail}` : result.detail;
  }
  return events;
}

export interface DeepSeekSessionView {
  title: string;
  messages: SessionMessage[];
  traceEvents: SessionTraceEvent[];
  usage: DeepSeekUsage;
  tokenEvents: TokenUsageEvent[];
}

/**
 * Project a parsed session log into a searchable transcript view: visible
 * user/assistant messages, tool trace events, the latest title, and usage.
 */
export function projectDeepSeekSession(log: DeepSeekSessionLog, source: SessionFormat = "deepseek"): DeepSeekSessionView {
  const fold = deepSeekTotalUsage(log.events, log.header.id);
  return {
    title: deepSeekTitle(log.events),
    messages: deepSeekSessionMessages(log),
    traceEvents: deepSeekSessionTraceEvents(log, source),
    usage: fold.usage,
    tokenEvents: fold.tokenEvents,
  };
}

/**
 * Delete the DeepSeek Harness session directory owning `filePath` (the
 * `session.jsonl.zstd` log). Only removes the session's own directory when it
 * still points at a DeepSeek log, never project siblings. Errors are ignored:
 * the index record is still removed by the caller.
 */
export function deleteDeepSeekCliSessionDirectory(filePath: string): void {
  try {
    const sessionDir = path.dirname(filePath);
    if (path.basename(filePath) !== DEEPSEEK_HARNESS_LOG_NAME) return;
    const projectDir = path.dirname(sessionDir);
    const sessionsDir = path.dirname(projectDir);
    if (path.basename(sessionsDir) !== "sessions") return;
    const logStat = fs.lstatSync(filePath);
    if (!logStat.isFile() || logStat.isSymbolicLink()) return;
    for (const directory of [sessionsDir, projectDir, sessionDir]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    }
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // Best-effort source cleanup; index deletion is the authoritative step.
  }
}
/**
 * Encode one path segment the way deepseek-harness does on disk: safe code
 * units pass through, every other UTF-16 code unit becomes `~XXXX`. Mirrors
 * deepseek-harness `encodeSegment` so migrated sessions land in the same
 * directories the harness itself would create.
 */
export function encodeDeepSeekPathSegment(segment: string): string {
  if (segment === ".") return "~002E";
  if (segment === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return out || "~002E";
}

/**
 * Build the harness project-directory key for a cwd: separators collapse into
 * a single dash and the slug is bounded like the harness (`--...--`). Mirrors
 * deepseek-harness `projectKey`.
 */
export function encodeDeepSeekProjectKey(cwd: string): string {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

/** The harness `_no-cwd` project directory for sessions without a cwd. */
export const DEEPSEEK_HARNESS_NO_CWD_DIR = "_no-cwd";

/**
 * Serialize a session transcript into the deepseek-harness on-disk format:
 * one header line plus surface events with contiguous sequence numbers,
 * compressed as a single Zstandard frame (`session.jsonl.zstd`). Messages are
 * projected back onto the surface as text blocks, so a migrated log reads and
 * resumes exactly like a harness-written one.
 */
export function serializeDeepSeekSessionLog(options: {
  sessionId: string;
  createdAt: number;
  cwd: string;
  messages: readonly { role: "user" | "assistant"; content: string; time: number }[];
  title?: string;
  parentSession?: string;
  delegationDepth?: number;
}): Buffer {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: "session",
    version: 0,
    id: options.sessionId,
    createdAt: options.createdAt,
    cwd: options.cwd,
    ...(options.parentSession ? { parentSession: options.parentSession } : {}),
    delegationDepth: options.parentSession ? options.delegationDepth ?? 1 : 0,
  }));

  let seq = 0;
  const event = (type: string, time: number, data: unknown, extra: Record<string, unknown> = {}) => {
    lines.push(JSON.stringify({ type, seq: seq++, time, data, ...extra }));
  };

  let turn = 1;
  const titleTime = options.title ? options.messages[0]?.time ?? options.createdAt : undefined;
  for (let i = 0; i < options.messages.length; i++) {
    const message = options.messages[i];
    const time = Number.isFinite(message.time) && message.time > 0 ? message.time : options.createdAt;
    event("turn/start", time, { turn });
    event("step/start", time, { turn, step: 1 });
    if (message.role === "user") {
      event("user/message", time, {
        id: `migrated-${turn}`,
        role: "user",
        content: [{ type: "text", text: message.content }],
        source: { kind: "user" },
      }, { surfaceOp: "append" });
    } else {
      event("assistant/message", time, {
        turn,
        step: 1,
        message: {
          id: `migrated-assistant-${turn}`,
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          source: { kind: "model", provider: "agent-recall-migration", model: "session-migration" },
        },
      }, { surfaceOp: "append", sourceEventSeqs: [] });
    }
    event("step/end", time, { turn, step: 1 });
    event("turn/end", time, { turn, reason: "complete" });
    turn += 1;
  }

  if (options.title) {
    event("session/title", titleTime ?? options.createdAt, {
      title: options.title,
      messageSeqs: [],
      source: { kind: "fallback" },
    });
  }

  return zlib.zstdCompressSync(Buffer.from(lines.join("\n") + "\n", "utf8"));
}
