import { execFile, type ExecFileOptions } from "node:child_process";
import {
  loadRemoteSessionPayloads,
  type RemoteSessionFileKind,
  type RemoteSessionFilePayload,
} from "./remote-session-loader";
import type { SessionStore } from "./session-store";
import { SESSION_SOURCE_DESCRIPTORS, sessionSourceDescriptor } from "./session-sources";
import { buildSshArgs } from "./ssh-config";
import type {
  IndexedSession,
  SessionEnvironment,
  SessionMessage,
  SessionMessageEvent,
  SessionSearchResult,
  SessionSource,
  TokenUsage,
  TokenUsageEvent,
} from "./types";

export interface RemoteSyncStatus {
  environmentId: string;
  indexed: number;
  error: string | null;
}

export interface RemoteSyncOptions {
  runSsh?: (environment: SessionEnvironment, remoteCommand: string) => Promise<string>;
  enabledOptionalSources?: SessionSource[];
}

export interface RemoteSessionSummaryPayload {
  kind: "codex-session" | "claude-project" | "codebuddy-project" | "codewiz-session" | "qoder-project";
  source?: SessionSource;
  path: string;
  mtimeMs: number;
  size: number;
  rawId: string;
  projectPath: string;
  timestamp: number;
  originalTitle: string;
  firstQuestion: string;
  messageCount: number;
  gitBranch?: string | null;
  tokenUsage?: TokenUsage;
  tokenEvents?: TokenUsageEvent[];
  messageEvents?: SessionMessageEvent[];
}

export interface RemoteSessionFileFetchOptions {
  runSsh?: (environment: SessionEnvironment, remoteCommand: string) => Promise<string>;
}

export const REMOTE_SYNC_EXEC_OPTIONS = {
  maxBuffer: 128 * 1024 * 1024,
  timeout: 90_000,
} satisfies ExecFileOptions;

// Shared Python message parser used by BOTH the lightweight summary collector and the
// on-demand message pager. The summary `messageCount` must match the number of messages the
// pager enumerates, otherwise the detail view (which loads the tail window
// `[messageCount - limit, messageCount)`) shows the wrong slice or hides the newest messages.
const REMOTE_MESSAGE_PARSER_PY = String.raw`import re
from datetime import datetime, timedelta, timezone

def text_from_blocks(content):
  if isinstance(content, str):
    return content
  if not isinstance(content, list):
    return ""
  parts = []
  for block in content:
    if not isinstance(block, dict):
      continue
    if block.get("type") in {"tool_use", "tool_result", "input_image"}:
      continue
    text = block.get("text") or block.get("input_text") or block.get("output_text")
    if isinstance(text, str) and text:
      parts.append(text)
  return "\n".join(parts)

def meaningful_user(text):
  value = text.strip()
  if not value:
    return False
  if re.match(r"^#\s*(AGENTS|CLAUDE)\.md", value, re.I):
    return False
  if re.match(r"^<(system-reminder|environment_context|command-message|command-name|command-args|task-notification|local-command-stdout|local-command-stderr|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)[\s>]", value):
    return False
  if value.startswith("Caveat:"):
    return False
  if re.match(r"^\[Request interrupted by user(?: for tool use)?\]$", value):
    return False
  if re.match(r"^\[Image:[^\]]*\]$", value):
    return False
  if re.match(r"^The beginning of the above subagent result is already visible", value):
    return False
  if re.match(r"^<system_notification>", value):
    return False
  return True

def codebuddy_timestamp(value):
  if isinstance(value, str):
    return value
  if isinstance(value, (int, float)) and not isinstance(value, bool):
    try:
      return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
      return ""
  return ""

def parse_message(row, kind):
  if not isinstance(row, dict):
    return None
  if kind == "codex":
    role = None
    content = None
    if row.get("type") == "response_item":
      payload = row.get("payload")
      if isinstance(payload, dict) and payload.get("type") == "message":
        role = payload.get("role")
        content = payload.get("content")
    elif row.get("type") == "message":
      role = row.get("role")
      content = row.get("content")
    if role not in {"user", "assistant"}:
      return None
    text = text_from_blocks(content)
    if not text or (role == "user" and not meaningful_user(text)):
      return None
    return {"role": role, "content": text, "timestamp": row.get("timestamp") if isinstance(row.get("timestamp"), str) else ""}
  if kind == "codebuddy":
    if row.get("type") != "message" or row.get("role") not in {"user", "assistant"}:
      return None
    text = text_from_blocks(row.get("content"))
    role = row.get("role")
    if not text or (role == "user" and not meaningful_user(text)):
      return None
    if role == "user" and row.get("parentId") is None and text.strip() == "code":
      return None
    return {"role": role, "content": text, "timestamp": codebuddy_timestamp(row.get("timestamp"))}
  if kind == "qoder":
    role = row.get("role")
    if role not in {"user", "assistant"}:
      return None
    message = row.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    text = text_from_blocks(content)
    if not text or (role == "user" and not meaningful_user(text)):
      return None
    return {"role": role, "content": text, "timestamp": ""}
  if row.get("type") not in {"user", "assistant"}:
    return None
  message = row.get("message")
  content = message.get("content") if isinstance(message, dict) else None
  text = text_from_blocks(content)
  if not text or (row.get("type") == "user" and not meaningful_user(text)):
    return None
  return {"role": row.get("type"), "content": text, "timestamp": row.get("timestamp") if isinstance(row.get("timestamp"), str) else ""}`;

// Token usage accounting for the summary collector. Mirrors session-loader.ts
// (extractCodexTokenEvents / extractClaudeTokenEvents) so the lightweight summary total matches
// the value computed when the session is fully hydrated on demand.
const REMOTE_TOKEN_USAGE_PY = String.raw`def _tok_num(value):
  return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0

def _tok_create(input_tokens, output_tokens, cached, reasoning):
  return {
    "inputTokens": input_tokens,
    "outputTokens": output_tokens,
    "cachedInputTokens": cached,
    "reasoningOutputTokens": reasoning,
    "totalTokens": input_tokens + output_tokens + cached + reasoning,
  }

def _tok_empty():
  return _tok_create(0, 0, 0, 0)

def _tok_add(total, nxt):
  total["inputTokens"] += nxt["inputTokens"]
  total["outputTokens"] += nxt["outputTokens"]
  total["cachedInputTokens"] += nxt["cachedInputTokens"]
  total["reasoningOutputTokens"] += nxt["reasoningOutputTokens"]
  total["totalTokens"] += nxt["totalTokens"]

def _iso_timestamp_ms(value):
  if not isinstance(value, str):
    return None
  match = re.match(r"^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$", value.strip())
  if not match:
    return None
  try:
    fraction = match.group(7) or ""
    microsecond = int((fraction + "000000")[:6])
    if match.group(8) or not match.group(9):
      tz = timezone.utc
    else:
      offset_hours = int(match.group(10))
      offset_minutes = int(match.group(11))
      if offset_hours > 23 or offset_minutes > 59:
        return None
      sign = 1 if match.group(9) == "+" else -1
      tz = timezone(timedelta(minutes=sign * (offset_hours * 60 + offset_minutes)))
    parsed = datetime(
      int(match.group(1)), int(match.group(2)), int(match.group(3)),
      int(match.group(4)), int(match.group(5)), int(match.group(6)),
      microsecond=microsecond, tzinfo=tz,
    )
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = parsed.astimezone(timezone.utc) - epoch
    return delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000
  except (OverflowError, TypeError, ValueError):
    return None

def _tok_timestamp(value):
  if isinstance(value, (int, float)) and not isinstance(value, bool):
    return int(value)
  parsed = _iso_timestamp_ms(value)
  return parsed if parsed is not None else 0

def _tok_event(timestamp, key, usage):
  event = dict(usage)
  event["timestamp"] = timestamp
  event["dedupeKey"] = key
  return event

def _tok_put(entries, key, event):
  existing = entries.get(key)
  if existing is None or event["totalTokens"] > existing["totalTokens"]:
    entries[key] = event

def _tok_total(events):
  total = _tok_empty()
  for event in events:
    _tok_add(total, event)
  return total

def _tok_normalize_codex(usage):
  cached = _tok_num(usage.get("cached_input_tokens")) + _tok_num(usage.get("cache_read_input_tokens"))
  reasoning = _tok_num(usage.get("reasoning_output_tokens"))
  return _tok_create(
    max(0, _tok_num(usage.get("input_tokens")) - cached),
    max(0, _tok_num(usage.get("output_tokens")) - reasoning),
    cached,
    reasoning,
  )

def _tok_cumulative_delta(current, previous_totals):
  best_index = -1
  best_distance = None
  for index in range(len(previous_totals)):
    previous = previous_totals[index]
    if previous["totalTokens"] > current["totalTokens"]:
      continue
    distance = current["totalTokens"] - previous["totalTokens"]
    if best_distance is None or distance < best_distance:
      best_distance = distance
      best_index = index
  if best_index < 0:
    previous_totals.append(dict(current))
    return dict(current)
  previous = previous_totals[best_index]
  delta = _tok_create(
    max(0, current["inputTokens"] - previous["inputTokens"]),
    max(0, current["outputTokens"] - previous["outputTokens"]),
    max(0, current["cachedInputTokens"] - previous["cachedInputTokens"]),
    max(0, current["reasoningOutputTokens"] - previous["reasoningOutputTokens"]),
  )
  previous_totals[best_index] = dict(current)
  return delta

def new_codex_token_state():
  return {"previous": [], "cumulative_entries": {}, "entries": {}, "model": ""}

def accumulate_codex_tokens(state, row):
  payload = row.get("payload")
  payload = payload if isinstance(payload, dict) else {}
  if row.get("type") == "turn_context":
    model = payload.get("model")
    if isinstance(model, str) and model:
      state["model"] = model
    return
  if row.get("type") != "event_msg" or payload.get("type") != "token_count":
    return
  info = payload.get("info")
  info = info if isinstance(info, dict) else {}
  model = info.get("model") if isinstance(info.get("model"), str) and info.get("model") else state["model"]
  timestamp = _tok_timestamp(row.get("timestamp"))
  total_usage = info.get("total_token_usage")
  if isinstance(total_usage, dict):
    current = _tok_normalize_codex(total_usage)
    delta = _tok_cumulative_delta(current, state["previous"])
    if delta["totalTokens"] > 0:
      key = "codex-total:%s:%s:%s:%s:%s:%s" % (model, timestamp, current["inputTokens"], current["outputTokens"], current["cachedInputTokens"], current["reasoningOutputTokens"])
      _tok_put(state["cumulative_entries"], key, _tok_event(timestamp, key, delta))
  last_usage = info.get("last_token_usage")
  if isinstance(last_usage, dict):
    last = _tok_normalize_codex(last_usage)
    total_input = _tok_num(total_usage.get("input_tokens")) if isinstance(total_usage, dict) else 0
    total_output = _tok_num(total_usage.get("output_tokens")) if isinstance(total_usage, dict) else 0
    key = "codex:%s:%s:%s:%s:%s:%s:%s" % (model, last["inputTokens"], last["outputTokens"], last["cachedInputTokens"], last["reasoningOutputTokens"], total_input, total_output)
    _tok_put(state["entries"], key, _tok_event(timestamp, key, last))

def finalize_codex_events(state):
  entries = state["cumulative_entries"] if state["cumulative_entries"] else state["entries"]
  return list(entries.values())

def finalize_codex_tokens(state):
  return _tok_total(finalize_codex_events(state))

def new_claude_token_state():
  return {"entries": {}, "index": 0}

def accumulate_claude_tokens(state, row):
  index = state["index"]
  state["index"] += 1
  if not isinstance(row, dict) or row.get("type") != "assistant":
    return
  message = row.get("message")
  message = message if isinstance(message, dict) else {}
  usage = message.get("usage")
  if not isinstance(usage, dict):
    return
  cached = _tok_num(usage.get("cache_read_input_tokens")) + _tok_num(usage.get("cached_input_tokens")) + _tok_num(usage.get("cache_creation_input_tokens"))
  entry = _tok_create(_tok_num(usage.get("input_tokens")), _tok_num(usage.get("output_tokens")), cached, _tok_num(usage.get("reasoning_output_tokens")))
  mid = message.get("id")
  uid = row.get("uuid")
  if isinstance(mid, str) and mid:
    key = mid
  elif isinstance(uid, str) and uid:
    key = uid
  else:
    key = "%d:%s" % (index, json.dumps(usage, ensure_ascii=False, separators=(",", ":")))
  if not key.startswith("claude-code:"):
    key = "claude-code:" + key
  _tok_put(state["entries"], key, _tok_event(_tok_timestamp(row.get("timestamp")), key, entry))

def finalize_claude_events(state):
  return list(state["entries"].values())

def finalize_claude_tokens(state):
  return _tok_total(finalize_claude_events(state))`;

export async function syncRemoteEnvironment(
  store: SessionStore,
  environment: SessionEnvironment,
  options: RemoteSyncOptions = {},
): Promise<RemoteSyncStatus> {
  const runSsh = options.runSsh ?? runSystemSsh;
  await store.updateEnvironmentSyncState(environment.id, "syncing", { lastError: null });
  try {
    const enabledOptionalSources = new Set(options.enabledOptionalSources ?? []);
    const output = await runSsh(environment, buildRemoteCollectorCommand([...enabledOptionalSources]));
    const { payloads, summaries } = decodeRemoteSyncOutput(output);
    const enabledSummaries = summaries.filter(
      (summary) => !isOptionalRemoteSource(summarySource(summary)) || enabledOptionalSources.has(summarySource(summary)),
    );
    for (const summary of enabledSummaries) {
      const session = remoteSummaryToIndexedSession(environment, summary);
      await migrateLegacyRemoteSessionRecord(store, session);
      await store.upsertIndexedSessionSummary(
        session,
        summary.messageCount,
        summary.tokenEvents,
        summary.messageEvents,
      );
    }
    const loaded = loadRemoteSessionPayloads(environment, payloads);
    for (const item of loaded) {
      await migrateLegacyRemoteSessionRecord(store, item.session);
      await store.upsertIndexedSession(item.session, item.messages, item.tokenEvents, item.traceEvents);
    }
    await store.updateEnvironmentSyncState(environment.id, "watching", { lastSyncedAt: Date.now(), lastError: null });
    return { environmentId: environment.id, indexed: enabledSummaries.length + loaded.length, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.updateEnvironmentSyncState(environment.id, "error", { lastError: message });
    throw error;
  }
}

async function migrateLegacyRemoteSessionRecord(store: SessionStore, session: IndexedSession): Promise<void> {
  const legacyFamily = session.source === "codex-cli" ? "codex" : session.source === "claude-cli" ? "claude" : null;
  if (!legacyFamily || !session.environmentId) return;
  await store.migrateSessionKeyPreservingUserState(
    `ssh:${session.environmentId}:${legacyFamily}:${session.rawId}`,
    session.sessionKey,
  );
}

function remoteSummaryToIndexedSession(environment: SessionEnvironment, summary: RemoteSessionSummaryPayload): IndexedSession {
  const source = summarySource(summary);
  const keySource = source === "codewiz-cli" ? "codewiz" : source;
  return {
    sessionKey: `ssh:${environment.id}:${keySource}:${summary.rawId}`,
    rawId: summary.rawId,
    source,
    projectPath: summary.projectPath,
    filePath: summary.path,
    originalTitle: summary.originalTitle || summary.firstQuestion || summary.rawId,
    firstQuestion: summary.firstQuestion,
    timestamp: summary.timestamp,
    fileMtimeMs: summary.mtimeMs,
    fileSize: summary.size,
    prUrl: null,
    prNumber: null,
    gitBranch: summary.gitBranch,
    tokenUsage: summary.tokenUsage,
    environmentId: environment.id,
    environmentKind: environment.kind,
    environmentLabel: environment.label,
  };
}

function summarySource(summary: RemoteSessionSummaryPayload): SessionSource {
  if (summary.source) return summary.source;
  if (summary.kind === "codex-session") return "codex-cli";
  if (summary.kind === "codebuddy-project") return "codebuddy-cli";
  if (summary.kind === "codewiz-session") return "codewiz-cli";
  return "claude-cli";
}

function isOptionalRemoteSource(source: SessionSource): boolean {
  return sessionSourceDescriptor(source).remoteCollectorOptional;
}

export function encodeRemotePayloadForTest(payloads: RemoteSessionFilePayload[]): string {
  return payloads
    .map((payload) =>
      JSON.stringify({ ...payload, contentBase64: Buffer.from(payload.content, "utf-8").toString("base64"), content: undefined }),
    )
    .join("\n");
}

export function decodeRemotePayload(output: string): RemoteSessionFilePayload[] {
  return decodeRemoteSyncOutput(output).payloads;
}

function decodeRemoteSyncOutput(output: string): { payloads: RemoteSessionFilePayload[]; summaries: RemoteSessionSummaryPayload[] } {
  const payloads: RemoteSessionFilePayload[] = [];
  const summaries: RemoteSessionSummaryPayload[] = [];
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const parsed = parseRemotePayloadLine(line, index + 1);
    if ("contentBase64" in parsed) {
      payloads.push({
        kind: parsed.kind,
        source: parsed.source,
        path: parsed.path,
        mtimeMs: parsed.mtimeMs,
        size: parsed.size,
        content: Buffer.from(parsed.contentBase64 || "", "base64").toString("utf-8"),
      });
    } else {
      summaries.push(parsed);
    }
  }
  return { payloads, summaries };
}

export function buildRemoteSyncSshArgs(environment: SessionEnvironment, remoteCommand: string): string[] {
  const baseArgs = buildSshArgs(
    {
      hostAlias: environment.hostAlias,
      host: environment.host,
      user: environment.user,
      port: environment.port,
      authMode: environment.authMode,
      identityFile: environment.identityFile,
    },
    remoteCommand,
  );
  const separatorIndex = baseArgs.indexOf("--");
  if (separatorIndex < 0) return [...REMOTE_SYNC_SSH_OPTIONS, ...baseArgs];
  return [...baseArgs.slice(0, separatorIndex), ...REMOTE_SYNC_SSH_OPTIONS, ...baseArgs.slice(separatorIndex)];
}

async function runSystemSsh(environment: SessionEnvironment, remoteCommand: string): Promise<string> {
  const args = buildRemoteSyncSshArgs(environment, remoteCommand);
  return new Promise((resolve, reject) => {
    execFile("ssh", args, REMOTE_SYNC_EXEC_OPTIONS, (error, stdout, stderr) => {
      if (error) reject(new Error(formatRemoteSyncProcessError(error, stdout, stderr)));
      else resolve(stdout);
    });
  });
}

export async function fetchRemoteSessionFilePayload(
  environment: SessionEnvironment,
  session: SessionSearchResult,
  options: RemoteSessionFileFetchOptions = {},
): Promise<RemoteSessionFilePayload> {
  const runSsh = options.runSsh ?? runSystemSsh;
  const kind = remoteKindForSource(session.source);
  const output = await runSsh(environment, buildRemoteFileFetchCommand({ path: session.filePath, source: session.source, kind }));
  const payloads = decodeRemotePayload(output);
  const payload = payloads.find((item) => item.path === session.filePath && item.kind === kind) ?? payloads[0];
  if (!payload) throw new Error("Remote session file fetch returned no payload.");
  return payload;
}

export async function fetchRemoteSessionMessagePage(
  environment: SessionEnvironment,
  session: SessionSearchResult,
  offset = 0,
  limit = 120,
  options: RemoteSessionFileFetchOptions = {},
): Promise<SessionMessage[]> {
  const runSsh = options.runSsh ?? runSystemSsh;
  const output = await runSsh(environment, buildRemoteMessagePageCommand(session, offset, limit));
  return decodeRemoteMessagePage(output);
}

export function remoteFamilyForSource(source: SessionSource): "claude" | "codex" | "codebuddy" | "codewiz" | "qoder" {
  return sessionSourceDescriptor(source).remoteFamily ?? "codex";
}

function remoteKindForSource(source: SessionSource): RemoteSessionFileKind {
  const family = remoteFamilyForSource(source);
  if (family === "codewiz") return "codewiz-session";
  if (family === "claude") return "claude-project";
  if (family === "codebuddy") return "codebuddy-project";
  if (family === "qoder") return "qoder-project";
  return "codex-session";
}

function buildRemoteFileFetchCommand(request: { path: string; source: SessionSource; kind: RemoteSessionFileKind }): string {
  const requestBase64 = Buffer.from(JSON.stringify(request), "utf-8").toString("base64");
  const script = String.raw`import base64, json
from pathlib import Path

request = json.loads(base64.b64decode("__REQUEST_B64__").decode("utf-8"))
path = Path(request["path"])
stat = path.stat()
content = path.read_bytes()
print(json.dumps({
  "kind": request["kind"],
  "source": request["source"],
  "path": str(path),
  "mtimeMs": int(stat.st_mtime * 1000),
  "size": stat.st_size,
  "contentBase64": base64.b64encode(content).decode("ascii"),
}, ensure_ascii=False))`.replace("__REQUEST_B64__", requestBase64);
  return buildPythonBase64Command(script);
}

function buildRemoteMessagePageCommand(session: SessionSearchResult, offset: number, limit: number): string {
  const [dbPath, codeWizSessionId] = session.source === "codewiz-cli" ? session.filePath.split("#", 2) : [session.filePath, ""];
  const request = {
    path: dbPath,
    codeWizSessionId,
    kind: remoteFamilyForSource(session.source),
    offset: Math.max(0, Math.floor(offset)),
    limit: Math.max(0, Math.min(500, Math.floor(limit))),
  };
  const body = String.raw`
request = __REQUEST_JSON__
path = Path(request["path"])
kind = request["kind"]
codewiz_session_id = request.get("codeWizSessionId", "")
offset = int(request["offset"])
limit = int(request["limit"])
end = offset + limit

messages = []
message_index = 0
if kind == "codewiz":
  import sqlite3
  def text_from_codewiz_part(data):
    if not isinstance(data, dict):
      return ""
    return data.get("text") if isinstance(data.get("text"), str) else ""
  def parse_codewiz_row(row):
    try:
      message_data = json.loads(row[2] or "{}")
    except Exception:
      message_data = {}
    try:
      part_data = json.loads(row[5] or "{}")
    except Exception:
      part_data = {}
    role = message_data.get("role") if isinstance(message_data, dict) else None
    if role not in {"user", "assistant"}:
      return None
    content = text_from_codewiz_part(part_data)
    if not content or (role == "user" and not meaningful_user(content)):
      return None
    return {"role": role, "content": content, "timestamp": row[4] if isinstance(row[4], (int, float)) else row[1]}
  db = sqlite3.connect(str(path))
  try:
    rows = db.execute("""
      SELECT message.id, message.time_created, message.data AS message_data,
        part.id AS part_id, part.time_created AS part_time_created, part.data AS part_data
      FROM message
      LEFT JOIN part ON part.message_id = message.id
      WHERE message.session_id = ?
      ORDER BY message.time_created, part.time_created, part.id
    """, (codewiz_session_id,)).fetchall()
    for row in rows:
      if limit <= 0:
        break
      parsed = parse_codewiz_row(row)
      if not parsed:
        continue
      if message_index >= offset and message_index < end:
        messages.append({"index": message_index, "role": parsed["role"], "content": parsed["content"], "timestamp": parsed["timestamp"]})
      message_index += 1
      if message_index >= end:
        break
  finally:
    db.close()
else:
  with path.open("r", encoding="utf-8", errors="replace") as handle:
    for line in handle:
      if limit <= 0:
        break
      try:
        row = json.loads(line)
      except Exception:
        continue
      parsed = parse_message(row, kind)
      if not parsed:
        continue
      if message_index >= offset and message_index < end:
        messages.append({
          "index": message_index,
          "role": parsed["role"],
          "content": parsed["content"],
          "timestamp": parsed["timestamp"],
        })
      message_index += 1
      if message_index >= end:
        break

print(json.dumps({"messages": messages}, ensure_ascii=False))`.replace("__REQUEST_JSON__", () => JSON.stringify(request));
  const script = `import json\nfrom pathlib import Path\n${REMOTE_MESSAGE_PARSER_PY}\n${body}`;
  return buildPythonBase64Command(script);
}

function decodeRemoteMessagePage(output: string): SessionMessage[] {
  const line = output
    .split("\n")
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return [];
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) throw new Error("Invalid remote message page payload.");
  return parsed.messages.flatMap((item): SessionMessage[] => {
    if (!isRecord(item)) return [];
    const index = numberField(item, "index");
    const role = item.role;
    const content = stringField(item, "content");
    if ((role !== "user" && role !== "assistant") || !content) return [];
    return [{ index: Math.max(0, Math.floor(index)), role, content, timestamp: stringField(item, "timestamp") }];
  });
}

export function formatRemoteSyncProcessError(error: unknown, stdout: string, stderr: string): string {
  const processError = error as { code?: string | number | null; killed?: boolean; message?: string; signal?: string | null };
  const reason = processError.killed
    ? `SSH remote sync timed out after ${Math.round((REMOTE_SYNC_EXEC_OPTIONS.timeout ?? 0) / 1000)}s.`
    : `SSH remote sync failed${processError.code ? ` with exit code ${processError.code}` : ""}.`;
  const cleanStderr = stderr.trim();
  if (cleanStderr) return `${reason} ${truncateRemoteError(cleanStderr)}`;

  const stdoutBytes = Buffer.byteLength(stdout);
  if (stdoutBytes > 0) {
    if (looksLikeRemotePayload(stdout)) {
      return `${reason} The remote produced ${formatBytes(stdoutBytes)} of session data before failing; the payload output is hidden to avoid flooding the app.`;
    }
    return `${reason} stdout: ${truncateRemoteError(stdout.trim())}`;
  }

  return `${reason} ${truncateRemoteError(processError.message || "No error details were returned.")}`;
}

function looksLikeRemotePayload(output: string): boolean {
  return /^\s*\{"kind":\s*"(?:codex-session|codex-index|claude-project|claude-session-index|codebuddy-project|codewiz-session)"/.test(output);
}

function truncateRemoteError(value: string, maxChars = 1200): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... truncated ${formatBytes(Buffer.byteLength(value))}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

type RemotePayloadWireRecord = Omit<RemoteSessionFilePayload, "content"> & { contentBase64: string };
type RemoteSyncWireRecord = RemotePayloadWireRecord | RemoteSessionSummaryPayload;

const REMOTE_SESSION_FILE_KINDS = new Set<RemoteSessionFilePayload["kind"]>([
  "codex-session",
  "codex-index",
  "claude-project",
  "claude-session-index",
  "codewiz-session",
  "codebuddy-project",
  "qoder-project",
]);

const REMOTE_SUMMARY_SOURCES = new Set<SessionSource>(
  SESSION_SOURCE_DESCRIPTORS.filter(({ remoteFamily }) => remoteFamily !== null).map(({ id }) => id),
);

const REMOTE_SYNC_SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

function parseRemotePayloadLine(line: string, lineNumber: number): RemoteSyncWireRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid remote payload at line ${lineNumber}: ${detail}`);
  }
  if (!isRecord(parsed)) throw new Error(`Invalid remote payload at line ${lineNumber}: expected object`);

  const kind = parsed.kind;
  if (typeof kind !== "string" || !REMOTE_SESSION_FILE_KINDS.has(kind as RemoteSessionFilePayload["kind"])) {
    throw new Error(`Invalid remote payload at line ${lineNumber}: invalid kind`);
  }
  if (typeof parsed.path !== "string") throw new Error(`Invalid remote payload at line ${lineNumber}: missing path`);
  if (typeof parsed.mtimeMs !== "number" || !Number.isFinite(parsed.mtimeMs)) {
    throw new Error(`Invalid remote payload at line ${lineNumber}: invalid mtimeMs`);
  }
  if (typeof parsed.size !== "number" || !Number.isFinite(parsed.size)) {
    throw new Error(`Invalid remote payload at line ${lineNumber}: invalid size`);
  }
  if (typeof parsed.contentBase64 !== "string") return parseRemoteSummaryRecord(parsed, lineNumber, kind as RemoteSessionSummaryPayload["kind"]);
  if (!isCanonicalBase64(parsed.contentBase64)) {
    throw new Error(`Invalid remote payload at line ${lineNumber}: invalid contentBase64`);
  }

  return {
    kind: kind as RemoteSessionFilePayload["kind"],
    source: remoteSourceField(parsed, lineNumber),
    path: parsed.path,
    mtimeMs: parsed.mtimeMs,
    size: parsed.size,
    contentBase64: parsed.contentBase64,
  };
}

function parseRemoteSummaryRecord(
  parsed: Record<string, unknown>,
  lineNumber: number,
  kind: RemoteSessionSummaryPayload["kind"],
): RemoteSessionSummaryPayload {
  if (kind !== "codex-session" && kind !== "claude-project" && kind !== "codebuddy-project" && kind !== "codewiz-session") {
    throw new Error(`Invalid remote payload at line ${lineNumber}: summaries must be session files`);
  }
  const rawId = stringField(parsed, "rawId");
  const projectPath = stringField(parsed, "projectPath");
  const originalTitle = stringField(parsed, "originalTitle");
  const firstQuestion = stringField(parsed, "firstQuestion");
  const timestamp = numberField(parsed, "timestamp");
  const messageCount = numberField(parsed, "messageCount");
  if (!rawId) throw new Error(`Invalid remote payload at line ${lineNumber}: missing rawId`);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error(`Invalid remote payload at line ${lineNumber}: invalid timestamp`);
  if (!Number.isFinite(messageCount) || messageCount < 0) throw new Error(`Invalid remote payload at line ${lineNumber}: invalid messageCount`);
  return {
    kind,
    source: remoteSourceField(parsed, lineNumber),
    path: stringField(parsed, "path"),
    mtimeMs: numberField(parsed, "mtimeMs"),
    size: numberField(parsed, "size"),
    rawId,
    projectPath,
    timestamp,
    originalTitle: originalTitle || firstQuestion || rawId,
    firstQuestion,
    messageCount,
    gitBranch: stringField(parsed, "gitBranch") || null,
    tokenUsage: tokenUsageField(parsed, "tokenUsage"),
    tokenEvents: tokenEventsField(parsed, "tokenEvents", lineNumber),
    messageEvents: messageEventsField(parsed, "messageEvents", lineNumber),
  };
}

function remoteSourceField(value: Record<string, unknown>, lineNumber: number): SessionSource | undefined {
  if (value.source === undefined) return undefined;
  if (typeof value.source !== "string" || !REMOTE_SUMMARY_SOURCES.has(value.source as SessionSource)) {
    throw new Error(`Invalid remote payload at line ${lineNumber}: invalid source`);
  }
  return value.source as SessionSource;
}

function messageEventsField(value: Record<string, unknown>, key: string, lineNumber: number): SessionMessageEvent[] | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`Invalid remote payload at line ${lineNumber}: invalid messageEvents`);
  return raw.map((item, index) => {
    const prefix = `Invalid remote payload at line ${lineNumber}: invalid messageEvents[${index}]`;
    if (!isRecord(item)) throw new Error(prefix);
    return {
      index: nonNegativeIntegerField(item, "index", prefix),
      timestamp: nonNegativeIntegerField(item, "timestamp", prefix),
    };
  });
}

function tokenUsageField(value: Record<string, unknown>, key: string): TokenUsage | undefined {
  const raw = value[key];
  if (!isRecord(raw)) return undefined;
  return {
    inputTokens: numberField(raw, "inputTokens"),
    outputTokens: numberField(raw, "outputTokens"),
    cachedInputTokens: numberField(raw, "cachedInputTokens"),
    reasoningOutputTokens: numberField(raw, "reasoningOutputTokens"),
    totalTokens: numberField(raw, "totalTokens"),
  };
}

function tokenEventsField(value: Record<string, unknown>, key: string, lineNumber: number): TokenUsageEvent[] | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`Invalid remote payload at line ${lineNumber}: invalid tokenEvents`);
  return raw.map((item, index) => parseTokenEvent(item, lineNumber, index));
}

function parseTokenEvent(value: unknown, lineNumber: number, index: number): TokenUsageEvent {
  const prefix = `Invalid remote payload at line ${lineNumber}: invalid tokenEvents[${index}]`;
  if (!isRecord(value)) throw new Error(prefix);
  const timestamp = nonNegativeFiniteField(value, "timestamp", prefix);
  const dedupeKey = stringField(value, "dedupeKey").trim();
  if (!dedupeKey) throw new Error(`${prefix}.dedupeKey`);
  const inputTokens = nonNegativeFiniteField(value, "inputTokens", prefix);
  const outputTokens = nonNegativeFiniteField(value, "outputTokens", prefix);
  const cachedInputTokens = nonNegativeFiniteField(value, "cachedInputTokens", prefix);
  const reasoningOutputTokens = nonNegativeFiniteField(value, "reasoningOutputTokens", prefix);
  const totalTokens = nonNegativeFiniteField(value, "totalTokens", prefix);
  if (totalTokens !== inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens) {
    throw new Error(`${prefix}.totalTokens`);
  }
  return {
    timestamp,
    dedupeKey,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function nonNegativeFiniteField(value: Record<string, unknown>, key: string, errorPrefix: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field) || field < 0) throw new Error(`${errorPrefix}.${key}`);
  return field;
}

function nonNegativeIntegerField(value: Record<string, unknown>, key: string, errorPrefix: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw new Error(`${errorPrefix}.${key}`);
  return field;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

const REMOTE_COLLECTOR_SCRIPT = String.raw`import json
import sqlite3
from pathlib import Path

MAX_SESSION_FILES = 2500
enabled_optional_sources = set(__ENABLED_OPTIONAL_SOURCES__)

home = Path.home()

${REMOTE_MESSAGE_PARSER_PY}

${REMOTE_TOKEN_USAGE_PY}

def title_from(text):
  lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
  return (lines[0] if lines else text.strip())[:120]

def load_codex_titles(config_dir):
  titles = {}
  index_path = home / config_dir / "session_index.jsonl"
  try:
    with index_path.open("r", encoding="utf-8", errors="replace") as handle:
      for line in handle:
        try:
          row = json.loads(line)
        except Exception:
          continue
        if not isinstance(row, dict):
          continue
        raw_id = row.get("id")
        title = row.get("thread_name")
        updated_at = row.get("updated_at")
        if isinstance(raw_id, str) and isinstance(title, str) and title:
          titles[raw_id] = (title, updated_at if isinstance(updated_at, str) else "")
  except Exception:
    pass
  return titles

def load_claude_index(config_dir):
  index = {}
  root = home / config_dir / "sessions"
  if not root.exists():
    return index
  for path in root.glob("*.json"):
    try:
      row = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
      continue
    if not isinstance(row, dict):
      continue
    raw_id = row.get("sessionId")
    if isinstance(raw_id, str) and raw_id:
      index[raw_id] = {
        "cwd": row.get("cwd") if isinstance(row.get("cwd"), str) else "",
        "startedAt": row.get("startedAt") if isinstance(row.get("startedAt"), (int, float)) else 0,
      }
  return index

def emit(record):
  print(json.dumps(record, ensure_ascii=False))

def emit_codex_summary(path, stat, titles, source):
  raw_id = path.stem
  project_path = ""
  timestamp = int(stat.st_mtime * 1000)
  first_question = ""
  message_count = 0
  message_events = []
  git_branch = ""
  token_state = new_codex_token_state()
  try:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
      for line in handle:
        try:
          row = json.loads(line)
        except Exception:
          continue
        if not isinstance(row, dict):
          continue
        if row.get("type") == "session_meta":
          payload = row.get("payload")
          if isinstance(payload, dict):
            raw_id = payload.get("id") if isinstance(payload.get("id"), str) else raw_id
            project_path = payload.get("cwd") if isinstance(payload.get("cwd"), str) else project_path
            git = payload.get("git")
            if isinstance(git, dict) and isinstance(git.get("branch"), str):
              git_branch = git.get("branch")
          parsed_timestamp = _iso_timestamp_ms(row.get("timestamp"))
          if parsed_timestamp is not None:
            timestamp = parsed_timestamp
          continue
        accumulate_codex_tokens(token_state, row)
        parsed = parse_message(row, "codex")
        if parsed:
          message_events.append({"index": message_count, "timestamp": _tok_timestamp(parsed["timestamp"])})
          message_count += 1
          if parsed["role"] == "user" and not first_question:
            first_question = parsed["content"]
  except Exception:
    return
  indexed_title = titles.get(raw_id, ("", ""))[0]
  emit({
    "kind": "codex-session",
    "source": source,
    "path": str(path),
    "mtimeMs": int(stat.st_mtime * 1000),
    "size": stat.st_size,
    "rawId": raw_id,
    "projectPath": project_path,
    "timestamp": timestamp,
    "originalTitle": indexed_title or title_from(first_question) or raw_id,
    "firstQuestion": first_question,
    "messageCount": message_count,
    "messageEvents": message_events,
    "gitBranch": git_branch,
    "tokenUsage": finalize_codex_tokens(token_state),
    "tokenEvents": finalize_codex_events(token_state),
  })

def emit_claude_summary(path, stat, index, source):
  raw_id = path.stem
  meta = index.get(raw_id, {})
  project_path = meta.get("cwd", "")
  timestamp = int(meta.get("startedAt") or stat.st_mtime * 1000)
  first_question = ""
  message_count = 0
  message_events = []
  git_branch = ""
  token_state = new_claude_token_state()
  try:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
      for line in handle:
        try:
          row = json.loads(line)
        except Exception:
          continue
        if not isinstance(row, dict) or row.get("type") not in {"user", "assistant"}:
          continue
        if not project_path and isinstance(row.get("cwd"), str):
          project_path = row.get("cwd")
        if not git_branch and isinstance(row.get("gitBranch"), str):
          git_branch = row.get("gitBranch")
        accumulate_claude_tokens(token_state, row)
        parsed = parse_message(row, "claude")
        if parsed:
          message_events.append({"index": message_count, "timestamp": _tok_timestamp(parsed["timestamp"])})
          message_count += 1
          if parsed["role"] == "user" and not first_question:
            first_question = parsed["content"]
  except Exception:
    return
  emit({
    "kind": "claude-project",
    "source": source,
    "path": str(path),
    "mtimeMs": int(stat.st_mtime * 1000),
    "size": stat.st_size,
    "rawId": raw_id,
    "projectPath": project_path,
    "timestamp": timestamp,
    "originalTitle": title_from(first_question) or raw_id,
    "firstQuestion": first_question,
    "messageCount": message_count,
    "messageEvents": message_events,
    "gitBranch": git_branch,
    "tokenUsage": finalize_claude_tokens(token_state),
    "tokenEvents": finalize_claude_events(token_state),
  })

def text_from_codewiz_part(data):
  if not isinstance(data, dict):
    return ""
  if isinstance(data.get("text"), str):
    return data.get("text")
  return ""

def codewiz_message_rows(db, session_id):
  try:
    return db.execute("""
      SELECT message.id, message.time_created, message.data AS message_data,
        part.id AS part_id, part.time_created AS part_time_created, part.data AS part_data
      FROM message
      LEFT JOIN part ON part.message_id = message.id
      WHERE message.session_id = ?
      ORDER BY message.time_created, part.time_created, part.id
    """, (session_id,)).fetchall()
  except Exception:
    return []

def parse_codewiz_row(row):
  try:
    message_data = json.loads(row[2] or "{}")
  except Exception:
    message_data = {}
  try:
    part_data = json.loads(row[5] or "{}")
  except Exception:
    part_data = {}
  role = message_data.get("role") if isinstance(message_data, dict) else None
  if role not in {"user", "assistant"}:
    return None
  content = text_from_codewiz_part(part_data)
  if not content or (role == "user" and not meaningful_user(content)):
    return None
  return {"role": role, "content": content, "timestamp": row[4] if isinstance(row[4], (int, float)) else row[1]}

def codewiz_tokens_from_data(data):
  if not isinstance(data, dict):
    return None
  tokens = data.get("tokens")
  if not isinstance(tokens, dict):
    return None
  cache = tokens.get("cache")
  if isinstance(cache, dict):
    cached = _tok_num(cache.get("read")) + _tok_num(cache.get("write"))
  else:
    cached = _tok_num(tokens.get("cached")) + _tok_num(tokens.get("cache_read")) + _tok_num(tokens.get("cache_write"))
  usage = _tok_create(_tok_num(tokens.get("input")), _tok_num(tokens.get("output")), cached, _tok_num(tokens.get("reasoning")))
  return usage if usage["totalTokens"] > 0 else None

def codewiz_token_events(rows, source):
  entries = {}
  for index, row in enumerate(rows):
    try:
      message_data = json.loads(row[2] or "{}")
    except Exception:
      message_data = {}
    try:
      part_data = json.loads(row[5] or "{}")
    except Exception:
      part_data = {}
    usage = codewiz_tokens_from_data(part_data) or codewiz_tokens_from_data(message_data)
    if not usage:
      continue
    raw_key = row[0] if isinstance(row[0], str) and row[0] else row[3] if isinstance(row[3], str) and row[3] else str(index)
    key = "%s:%s" % (source, raw_key)
    timestamp = row[4] if isinstance(row[4], (int, float)) else row[1]
    _tok_put(entries, key, _tok_event(_tok_timestamp(timestamp), key, usage))
  return list(entries.values())

def codewiz_token_usage(session):
  return _tok_create(
    session["tokens_input"] if "tokens_input" in session.keys() and session["tokens_input"] else 0,
    session["tokens_output"] if "tokens_output" in session.keys() and session["tokens_output"] else 0,
    (session["tokens_cache_read"] if "tokens_cache_read" in session.keys() and session["tokens_cache_read"] else 0) + (session["tokens_cache_write"] if "tokens_cache_write" in session.keys() and session["tokens_cache_write"] else 0),
    session["tokens_reasoning"] if "tokens_reasoning" in session.keys() and session["tokens_reasoning"] else 0,
  )

def emit_codewiz_summaries(db_path, stat):
  try:
    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row
    sessions = db.execute("SELECT * FROM session ORDER BY time_updated DESC LIMIT ?", (MAX_SESSION_FILES,)).fetchall()
  except Exception:
    return
  try:
    for session in sessions:
      raw_id = session["id"]
      first_question = ""
      message_count = 0
      message_events = []
      rows = codewiz_message_rows(db, raw_id)
      token_events = codewiz_token_events(rows, "codewiz")
      for row in rows:
        parsed = parse_codewiz_row(row)
        if not parsed:
          continue
        message_events.append({"index": message_count, "timestamp": _tok_timestamp(parsed["timestamp"])})
        message_count += 1
        if parsed["role"] == "user" and not first_question:
          first_question = parsed["content"]
      emit({
        "kind": "codewiz-session",
        "path": "%s#%s" % (str(db_path), raw_id),
        "mtimeMs": int(stat.st_mtime * 1000),
        "size": stat.st_size,
        "rawId": raw_id,
        "projectPath": session["directory"] if isinstance(session["directory"], str) else "",
        "timestamp": session["time_updated"] or session["time_created"] or int(stat.st_mtime * 1000),
        "originalTitle": session["title"] or title_from(first_question) or raw_id,
        "firstQuestion": first_question,
        "messageCount": message_count,
        "messageEvents": message_events,
        "gitBranch": "",
        "tokenUsage": _tok_total(token_events) if token_events else codewiz_token_usage(session),
        "tokenEvents": token_events,
      })
  finally:
    try:
      db.close()
    except Exception:
      pass
def _codebuddy_detail(value, key):
  if isinstance(value, list) and value:
    value = value[0]
  return _tok_num(value.get(key)) if isinstance(value, dict) else 0

def _codebuddy_usage(provider_data):
  usage = provider_data.get("usage")
  if isinstance(usage, dict):
    total_input = _tok_num(usage.get("inputTokens"))
    total_output = _tok_num(usage.get("outputTokens"))
    cached = _codebuddy_detail(usage.get("inputTokensDetails"), "cached_tokens")
    reasoning = _codebuddy_detail(usage.get("outputTokensDetails"), "reasoning_tokens")
  else:
    total_input = total_output = cached = reasoning = 0
  raw_usage = provider_data.get("rawUsage")
  if total_input == 0 and total_output == 0 and isinstance(raw_usage, dict):
    total_input = _tok_num(raw_usage.get("prompt_tokens"))
    total_output = _tok_num(raw_usage.get("completion_tokens"))
    cached = _codebuddy_detail(raw_usage.get("prompt_tokens_details"), "cached_tokens")
    reasoning = _codebuddy_detail(raw_usage.get("completion_tokens_details"), "reasoning_tokens")
  if total_input == 0 and total_output == 0:
    return None
  return _tok_create(max(0, total_input - cached), max(0, total_output - reasoning), cached, reasoning)

def emit_codebuddy_summary(path, stat):
  raw_id = path.stem
  project_path = ""
  timestamp = int(stat.st_mtime * 1000)
  original_title = ""
  first_question = ""
  message_count = 0
  message_events = []
  token_entries = {}
  try:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
      for index, line in enumerate(handle):
        try:
          row = json.loads(line)
        except Exception:
          continue
        if not isinstance(row, dict):
          continue
        if isinstance(row.get("sessionId"), str) and row.get("sessionId") and raw_id == path.stem:
          raw_id = row.get("sessionId")
        if not project_path and isinstance(row.get("cwd"), str):
          project_path = row.get("cwd")
        row_timestamp = _tok_timestamp(row.get("timestamp"))
        if row_timestamp and timestamp == int(stat.st_mtime * 1000):
          timestamp = row_timestamp
        if row.get("type") == "ai-title" and isinstance(row.get("aiTitle"), str) and row.get("aiTitle").strip() and not original_title:
          original_title = row.get("aiTitle").strip()
        if row.get("type") == "message" and row.get("role") == "assistant":
          provider_data = row.get("providerData")
          usage = _codebuddy_usage(provider_data) if isinstance(provider_data, dict) else None
          if usage:
            key_value = provider_data.get("messageId") or row.get("id") or "%s:%s:%s" % (index, usage["inputTokens"], usage["outputTokens"])
            key = str(key_value)
            if not key.startswith("codebuddy:"):
              key = "codebuddy:" + key
            _tok_put(token_entries, key, _tok_event(row_timestamp, key, usage))
        parsed = parse_message(row, "codebuddy")
        if parsed:
          message_events.append({"index": message_count, "timestamp": _tok_timestamp(parsed["timestamp"])})
          message_count += 1
          if parsed["role"] == "user" and not first_question:
            first_question = parsed["content"]
  except Exception:
    return
  token_events = list(token_entries.values())
  emit({
    "kind": "codebuddy-project",
    "source": "codebuddy-cli",
    "path": str(path),
    "mtimeMs": int(stat.st_mtime * 1000),
    "size": stat.st_size,
    "rawId": raw_id,
    "projectPath": project_path,
    "timestamp": timestamp,
    "originalTitle": original_title or title_from(first_question) or raw_id,
    "firstQuestion": first_question,
    "messageCount": message_count,
    "messageEvents": message_events,
    "gitBranch": "",
    "tokenUsage": _tok_total(token_events),
    "tokenEvents": token_events,
  })
def emit_qoder_summary(path, stat):
  raw_id = path.stem
  project_path = ""
  timestamp = int(stat.st_mtime * 1000)
  first_question = ""
  message_count = 0
  message_events = []
  path_str = str(path)
  slug = ""
  if "/projects/" in path_str:
    after_projects = path_str.split("/projects/")[1]
    slug = after_projects.split("/")[0]
  if slug:
    raw_id = "%s/%s" % (slug, path.stem)
    project_path = re.sub(r"-[0-9a-f]{8}$", "", slug) or slug
  try:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
      for index, line in enumerate(handle):
        try:
          row = json.loads(line)
        except Exception:
          continue
        if not isinstance(row, dict):
          continue
        parsed = parse_message(row, "qoder")
        if parsed:
          message_events.append({"index": message_count, "timestamp": _tok_timestamp(parsed["timestamp"])})
          message_count += 1
          if parsed["role"] == "user" and not first_question:
            first_question = parsed["content"]
  except Exception:
    return
  emit({
    "kind": "qoder-project",
    "source": "qoder",
    "path": str(path),
    "mtimeMs": int(stat.st_mtime * 1000),
    "size": stat.st_size,
    "rawId": raw_id,
    "projectPath": project_path,
    "timestamp": timestamp,
    "originalTitle": title_from(first_question) or raw_id,
    "firstQuestion": first_question,
    "messageCount": message_count,
    "messageEvents": message_events,
    "gitBranch": "",
    "tokenUsage": _tok_empty(),
    "tokenEvents": [],
  })
candidates = []
sources = [
  ("codex-session", "codex-cli", home / ".codex" / "sessions", "*.jsonl"),
  ("claude-project", "claude-cli", home / ".claude" / "projects", "*.jsonl"),
]
optional_sources = [__OPTIONAL_SOURCE_DESCRIPTORS__]
sources.extend(item for item in optional_sources if item[1] in enabled_optional_sources)
for kind, source, root, pattern in sources:
  if not root.exists():
    continue
  paths = root.rglob(pattern) if root.is_dir() else []
  for path in paths:
    try:
      stat = path.stat()
      candidates.append((stat.st_mtime, kind, source, path, stat.st_size))
    except Exception:
      pass

codewiz_db = home / ".local" / "share" / "codewiz" / "opencode.db"
try:
  if codewiz_db.exists():
    emit_codewiz_summaries(codewiz_db, codewiz_db.stat())
except Exception:
  pass
codex_titles = {
  "codex-cli": load_codex_titles(".codex"),
  __OPTIONAL_CODEX_TITLE_INDEXES__
}
claude_indexes = {
  "claude-cli": load_claude_index(".claude"),
  __OPTIONAL_CLAUDE_INDEXES__
}
for _mtime, kind, source, path, _size in sorted(candidates, key=lambda item: item[0], reverse=True)[:MAX_SESSION_FILES]:
  try:
    stat = path.stat()
    if kind == "codex-session":
      emit_codex_summary(path, stat, codex_titles.get(source, {}), source)
    elif kind == "claude-project":
      emit_claude_summary(path, stat, claude_indexes.get(source, {}), source)
    elif kind == "qoder-project":
      emit_qoder_summary(path, stat)
    else:
      emit_codebuddy_summary(path, stat)
  except Exception:
    pass`;

function buildRemoteCollectorCommand(enabledOptionalSources: SessionSource[]): string {
  const descriptors: Record<string, string> = {
    "tclaude-cli": '("claude-project", "tclaude-cli", home / ".tclaude" / "projects", "*.jsonl")',
    "tcodex-cli": '("codex-session", "tcodex-cli", home / ".tcodex" / "sessions", "*.jsonl")',
    "codebuddy-cli": '("codebuddy-project", "codebuddy-cli", home / ".codebuddy" / "projects", "*.jsonl")',
    "qoder": '("qoder-project", "qoder", home / ".qoder" / "cache" / "projects", "*.jsonl")',
  };
  const optionalSources = enabledOptionalSources.filter((source) => source in descriptors);
  const optionalCodexTitleIndexes = optionalSources.includes("tcodex-cli")
    ? '"tcodex-cli": load_codex_titles(".tcodex"),'
    : "";
  const optionalClaudeIndexes = optionalSources.includes("tclaude-cli")
    ? '"tclaude-cli": load_claude_index(".tclaude"),'
    : "";
  const script = REMOTE_COLLECTOR_SCRIPT
    .replace("__ENABLED_OPTIONAL_SOURCES__", JSON.stringify(optionalSources))
    .replace("__OPTIONAL_SOURCE_DESCRIPTORS__", optionalSources.map((source) => descriptors[source]).join(",\n  "))
    .replace("__OPTIONAL_CODEX_TITLE_INDEXES__", optionalCodexTitleIndexes)
    .replace("__OPTIONAL_CLAUDE_INDEXES__", optionalClaudeIndexes);
  return buildPythonBase64Command(script);
}

function buildPythonBase64Command(script: string): string {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const compressed = zlib.deflateRawSync(Buffer.from(script, "utf-8"));
  const encoded = compressed.toString("base64");
  return `python3 -c 'import base64,zlib; exec(zlib.decompress(base64.b64decode("${encoded}"), -15).decode("utf-8"))'`;
}
