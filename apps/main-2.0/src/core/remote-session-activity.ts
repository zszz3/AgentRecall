import { createRequire } from "node:module";
import { LIVE_SESSION_INACTIVITY_TIMEOUT_MS } from "./refresh-policy";
import type { LiveSession, SessionEnvironment } from "./types";

const require = createRequire(import.meta.url);
const { deflateRawSync } = require("node:zlib") as typeof import("node:zlib");

const REMOTE_CODEX_ACTIVITY_SCRIPT = String.raw`
import json
import os
import re
import shlex
import subprocess
import time
from pathlib import Path

INACTIVITY_TIMEOUT_MS = ${LIVE_SESSION_INACTIVITY_TIMEOUT_MS}
CLAUDE_SESSION_START_SKEW_MS = 2 * 60 * 1000
READ_CHUNK_SIZE = 64 * 1024
SESSION_ID_PATTERN = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$", re.IGNORECASE)
proc_root = Path(os.environ.get("AGENT_RECALL_PROC_ROOT", "/proc"))

def normalized_executable(token):
  name = token.replace("\\", "/").rsplit("/", 1)[-1].lower()
  return re.sub(r"\.(?:js|cjs|mjs|cmd|exe)$", "", name)

def codex_command_index(tokens):
  if not tokens:
    return None
  indexes = [1] if normalized_executable(tokens[0]) in {"node", "nodejs"} else [0]
  for index in indexes:
    if index >= len(tokens):
      continue
    token = tokens[index]
    if normalized_executable(token) == "codex" or "@openai/codex" in token.lower():
      return index
  return None

def claude_command_index(tokens):
  if not tokens:
    return None
  indexes = [1] if normalized_executable(tokens[0]) in {"node", "nodejs"} else [0]
  for index in indexes:
    if index >= len(tokens):
      continue
    token = tokens[index]
    normalized = normalized_executable(token)
    lower = token.lower()
    if normalized in {"claude", "claude-code"} or "@anthropic-ai/claude" in lower or "claude-code" in lower:
      return index
  return None

def flag_resume_id(args):
  for index, arg in enumerate(args):
    if arg in {"--resume", "-r"} and index + 1 < len(args):
      raw_id = args[index + 1].strip()
      if raw_id and not raw_id.startswith("-"):
        return raw_id
    if arg.startswith("--resume="):
      raw_id = arg[len("--resume="):].strip()
      if raw_id:
        return raw_id
  return None

def process_rows():
  rows = []
  if proc_root.is_dir():
    try:
      entries = sorted(proc_root.iterdir(), key=lambda entry: int(entry.name) if entry.name.isdigit() else -1)
    except Exception:
      entries = []
    for entry in entries:
      if not entry.name.isdigit():
        continue
      try:
        parts = (entry / "cmdline").read_bytes().split(b"\0")
        tokens = [part.decode("utf-8", errors="replace") for part in parts if part]
      except Exception:
        continue
      if tokens:
        rows.append((int(entry.name), tokens))
  if rows or "AGENT_RECALL_PROC_ROOT" in os.environ:
    return rows
  try:
    output = subprocess.run(
      ["ps", "-axo", "pid=,command="],
      check=True,
      stdout=subprocess.PIPE,
      stderr=subprocess.DEVNULL,
      text=True,
    ).stdout
  except Exception:
    return rows
  for line in output.splitlines():
    match = re.match(r"^\s*(\d+)\s+(.+)$", line)
    if not match:
      continue
    try:
      tokens = shlex.split(match.group(2))
    except Exception:
      tokens = match.group(2).split()
    if tokens:
      rows.append((int(match.group(1)), tokens))
  return rows

def open_files(pid):
  paths = []
  fd_root = proc_root / str(pid) / "fd"
  if fd_root.is_dir():
    try:
      descriptors = list(fd_root.iterdir())
    except Exception:
      descriptors = []
    for descriptor in descriptors:
      try:
        target = os.readlink(descriptor)
      except Exception:
        continue
      if target.endswith(" (deleted)"):
        target = target[:-10]
      paths.append(target)
  if paths or "AGENT_RECALL_PROC_ROOT" in os.environ:
    return paths
  try:
    output = subprocess.run(
      ["lsof", "-Fn", "-p", str(pid)],
      check=False,
      stdout=subprocess.PIPE,
      stderr=subprocess.DEVNULL,
      text=True,
    ).stdout
  except Exception:
    return paths
  return [line[1:] for line in output.splitlines() if line.startswith("n") and len(line) > 1]

def process_cwd(pid):
  try:
    return os.readlink(proc_root / str(pid) / "cwd")
  except Exception:
    return None

def process_started_at_ms(pid):
  try:
    stat_text = (proc_root / str(pid) / "stat").read_text(encoding="utf-8", errors="replace")
    fields = stat_text.rsplit(")", 1)[1].split()
    start_ticks = float(fields[19])
    ticks_per_second = float(os.sysconf("SC_CLK_TCK"))
    uptime_seconds = float((proc_root / "uptime").read_text().split()[0])
    return time.time() * 1000 - uptime_seconds * 1000 + start_ticks * 1000 / ticks_per_second
  except Exception:
    return None

def claude_session_id(file_name):
  normalized = file_name.replace("\\", "/")
  if "/.claude/projects/" not in normalized or not normalized.lower().endswith(".jsonl"):
    return None
  raw_id = normalized.rsplit("/", 1)[-1][:-len(".jsonl")].strip()
  if "/subagents/" in normalized:
    raw_id = re.sub(r"^agent-?", "", raw_id)
  return raw_id or None

def fallback_claude_session_id(pid):
  cwd = process_cwd(pid)
  if not cwd:
    return None
  project_dir = Path.home() / ".claude" / "projects" / re.sub(r"[^a-zA-Z0-9-]", "-", cwd)
  try:
    entries = [entry for entry in project_dir.iterdir() if entry.is_file() and entry.name.endswith(".jsonl")]
  except Exception:
    return None
  started_at_ms = process_started_at_ms(pid)
  candidates = []
  for entry in entries:
    try:
      stat = entry.stat()
    except Exception:
      continue
    created_at_ms = stat.st_ctime * 1000
    modified_at_ms = stat.st_mtime * 1000
    if started_at_ms is not None and max(created_at_ms, modified_at_ms) < started_at_ms - CLAUDE_SESSION_START_SKEW_MS:
      continue
    created_for_process = started_at_ms is None or created_at_ms >= started_at_ms - CLAUDE_SESSION_START_SKEW_MS
    distance_ms = -modified_at_ms if started_at_ms is None else abs((created_at_ms if created_for_process else modified_at_ms) - started_at_ms)
    candidates.append((0 if created_for_process else 1, distance_ms, entry.name[:-len(".jsonl")]))
  if not candidates:
    return None
  candidates.sort()
  return candidates[0][2]

def reverse_lines(path):
  with path.open("rb") as handle:
    handle.seek(0, os.SEEK_END)
    position = handle.tell()
    partial = b""
    while position > 0:
      read_size = min(READ_CHUNK_SIZE, position)
      position -= read_size
      handle.seek(position)
      block = handle.read(read_size) + partial
      lines = block.split(b"\n")
      partial = lines[0]
      for line in reversed(lines[1:]):
        if line:
          yield line
    if partial:
      yield partial

def agent_is_working(path):
  try:
    stat = path.stat()
    if time.time() * 1000 - stat.st_mtime * 1000 >= INACTIVITY_TIMEOUT_MS:
      return False
    for line in reverse_lines(path):
      try:
        row = json.loads(line)
      except Exception:
        continue
      if row.get("type") != "event_msg":
        continue
      payload = row.get("payload")
      event_type = payload.get("type") if isinstance(payload, dict) else None
      if event_type == "task_started":
        return True
      if event_type in {"task_complete", "turn_aborted"}:
        return False
  except Exception:
    return False
  return False

seen = set()

def emit_session(family, raw_id, pid):
  normalized = raw_id.strip() if isinstance(raw_id, str) else ""
  key = (family, normalized)
  if not normalized or key in seen:
    return
  seen.add(key)
  print(json.dumps({"family": family, "rawId": normalized, "pid": pid}, separators=(",", ":")))

for pid, tokens in process_rows():
  command_index = codex_command_index(tokens)
  if command_index is not None:
    args = tokens[command_index + 1:]
    resumed_id = None
    if "resume" in args:
      resume_index = args.index("resume")
      if resume_index + 1 < len(args):
        raw_id = args[resume_index + 1].strip()
        if raw_id and not raw_id.startswith("-"):
          resumed_id = raw_id
          emit_session("codex", raw_id, pid)
    if "app-server" in args:
      for file_name in open_files(pid):
        if "/.codex/sessions/" not in file_name.replace("\\", "/"):
          continue
        match = SESSION_ID_PATTERN.search(file_name)
        if match and agent_is_working(Path(file_name)):
          emit_session("codex", match.group(1), pid)
    elif resumed_id is None and normalized_executable(tokens[command_index]) == "codex":
      emit_session("codex", "*", pid)

  command_index = claude_command_index(tokens)
  if command_index is None:
    continue
  args = tokens[command_index + 1:]
  resumed_id = flag_resume_id(args)
  if resumed_id:
    emit_session("claude", resumed_id, pid)
    continue
  open_session_ids = [raw_id for raw_id in (claude_session_id(file_name) for file_name in open_files(pid)) if raw_id]
  if open_session_ids:
    for raw_id in open_session_ids:
      emit_session("claude", raw_id, pid)
    continue
  fallback_id = fallback_claude_session_id(pid)
  if fallback_id:
    emit_session("claude", fallback_id, pid)
  emit_session("claude", "*", pid)
`;

const remoteScriptPayload = deflateRawSync(Buffer.from(REMOTE_CODEX_ACTIVITY_SCRIPT, "utf8")).toString("base64");
const REMOTE_CODEX_ACTIVITY_COMMAND =
  `python3 -c 'import base64,zlib; exec(zlib.decompress(base64.b64decode("${remoteScriptPayload}"), -15).decode("utf-8"))'`;

type RemoteCommandRunner = (environment: SessionEnvironment, remoteCommand: string) => Promise<string>;

export async function loadRemoteLiveSessions(
  environments: readonly SessionEnvironment[],
  runRemoteCommand: RemoteCommandRunner,
): Promise<LiveSession[]> {
  const outputs = await Promise.all(
    environments
      .filter((environment) => (environment.kind === "ssh" || environment.kind === "wsl") && environment.enabled)
      .map(async (environment) => {
        try {
          const output = await runRemoteCommand(environment, REMOTE_CODEX_ACTIVITY_COMMAND);
          return parseRemoteLiveSessions(output, environment.id);
        } catch (error) {
          if (environment.kind === "wsl") {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not inspect live sessions in WSL environment ${environment.label}: ${detail}`);
          }
          return [];
        }
      }),
  );

  const sessions: LiveSession[] = [];
  const seen = new Set<string>();
  for (const output of outputs) {
    for (const session of output) {
      const key = `${session.environmentId}:${session.family}:${session.rawId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push(session);
    }
  }
  return sessions;
}

function parseRemoteLiveSessions(output: string, environmentId: string): LiveSession[] {
  const sessions: LiveSession[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if ((value.family !== "codex" && value.family !== "claude") || typeof value.rawId !== "string") continue;
      if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) continue;
      const rawId = value.rawId.trim();
      if (!rawId) continue;
      sessions.push({ family: value.family, rawId, pid: value.pid, environmentId });
    } catch {
      continue;
    }
  }
  return sessions;
}
