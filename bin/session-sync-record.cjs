#!/usr/bin/env node
"use strict";

// Lightweight Claude Code / Codex Stop hook target. It never reads application
// settings or performs network requests; it only leaves one event file for the
// running desktop app (or the next app launch) to consume.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function defaultHomeDir() {
  return process.env.AGENT_RECALL_TEST_HOME || os.homedir();
}

function queueDirectory(homeDir) {
  return process.env.AGENT_RECALL_SYNC_QUEUE || path.join(homeDir || defaultHomeDir(), ".agent-recall", "session-sync-queue");
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function buildSessionSyncEvent(input, agent, now) {
  if (!input || typeof input !== "object") return null;
  if (agent !== "claude" && agent !== "codex") return null;
  const sessionId = cleanString(input.session_id, 512);
  if (!sessionId) return null;
  return {
    version: 1,
    agent,
    sessionId,
    transcriptPath: cleanString(input.transcript_path, 32_768),
    cwd: cleanString(input.cwd, 32_768),
    queuedAt: (now || (() => new Date()))().toISOString(),
  };
}

function writeSessionSyncEvent(event, options) {
  const opts = options || {};
  const queueDir = opts.queueDir || queueDirectory(opts.homeDir);
  fs.mkdirSync(queueDir, { recursive: true });
  const filePath = path.join(queueDir, `${Date.now()}-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "wx" });
  return filePath;
}

function agentFromArgs(argv) {
  const index = argv.indexOf("--agent");
  return index >= 0 ? argv[index + 1] : "";
}

function runHook() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdin += chunk;
    if (stdin.length > 1024 * 1024) process.exit(0);
  });
  process.stdin.on("end", () => {
    try {
      const input = stdin.trim() ? JSON.parse(stdin) : {};
      const event = buildSessionSyncEvent(input, agentFromArgs(process.argv));
      if (event) writeSessionSyncEvent(event);
    } catch {
      // Hooks must never interrupt the host session.
    }
  });
}

module.exports = { buildSessionSyncEvent, writeSessionSyncEvent, queueDirectory, agentFromArgs };

if (require.main === module) runHook();
