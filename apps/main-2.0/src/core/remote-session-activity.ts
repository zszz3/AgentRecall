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
for pid, tokens in process_rows():
  command_index = codex_command_index(tokens)
  if command_index is None:
    continue
  args = tokens[command_index + 1:]
  if "resume" in args:
    resume_index = args.index("resume")
    if resume_index + 1 < len(args):
      raw_id = args[resume_index + 1].strip()
      if raw_id and not raw_id.startswith("-") and raw_id not in seen:
        seen.add(raw_id)
        print(json.dumps({"family": "codex", "rawId": raw_id, "pid": pid}, separators=(",", ":")))
  if "app-server" not in args:
    continue
  for file_name in open_files(pid):
    if "/.codex/sessions/" not in file_name.replace("\\", "/"):
      continue
    match = SESSION_ID_PATTERN.search(file_name)
    if not match:
      continue
    raw_id = match.group(1)
    if raw_id in seen or not agent_is_working(Path(file_name)):
      continue
    seen.add(raw_id)
    print(json.dumps({"family": "codex", "rawId": raw_id, "pid": pid}, separators=(",", ":")))
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
      .filter((environment) => environment.kind === "ssh" && environment.enabled)
      .map(async (environment) => {
        try {
          const output = await runRemoteCommand(environment, REMOTE_CODEX_ACTIVITY_COMMAND);
          return parseRemoteLiveSessions(output, environment.id);
        } catch {
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
      if (value.family !== "codex" || typeof value.rawId !== "string") continue;
      if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) continue;
      const rawId = value.rawId.trim();
      if (!rawId) continue;
      sessions.push({ family: "codex", rawId, pid: value.pid, environmentId });
    } catch {
      continue;
    }
  }
  return sessions;
}
