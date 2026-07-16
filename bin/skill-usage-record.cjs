#!/usr/bin/env node
"use strict";

// Claude Code PostToolUse hook target. Fires after every `Skill` tool call and
// appends one usage record to ~/.claude/skill-usage.jsonl. Append-only JSONL is
// concurrency-safe across parallel Claude Code processes, and the session JSONL
// transcripts do not record skill invocations on their own, so this bridge is
// the only reliable source of per-skill usage counts.
//
// Self-contained CommonJS (no build output or dependencies) so it runs straight
// from a freshly unpacked global install.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME_DIR = process.env.AGENT_RECALL_TEST_HOME || os.homedir();
const DEFAULT_OUTPUT = path.join(HOME_DIR, ".claude", "skill-usage.jsonl");
const outputPath = expandHome(process.env.AGENT_RECALL_SKILL_USAGE || DEFAULT_OUTPUT);

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
  if (stdin.length > 4 * 1024 * 1024) {
    process.stderr.write("Skill usage hook input is too large.\n");
    process.exit(0);
  }
});

process.stdin.on("end", () => {
  // A hook must never break the host. Swallow every failure and exit 0.
  try {
    const input = stdin.trim() ? JSON.parse(stdin) : {};
    const record = buildRecord(input);
    if (!record) return;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Intentionally silent: never disrupt the Claude Code session.
  }
});

// Returns a usage record, or null when the payload is not a recordable skill
// invocation. Only the `Skill` tool path is recorded, since that is the
// reliable, model-driven way skills are used. Slash-invoked skills go through
// UserPromptExpansion with an unstable schema and are intentionally skipped to
// avoid miscounting ordinary prompts.
function buildRecord(input) {
  if (!input || typeof input !== "object") return null;
  if (input.tool_name !== "Skill") return null;

  const skill = extractSkillName(input.tool_input);
  if (!skill) return null;

  return {
    skill,
    agent: "claude",
    event: typeof input.hook_event_name === "string" ? input.hook_event_name : "PostToolUse",
    ts: new Date().toISOString(),
  };
}

function extractSkillName(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  for (const key of ["skill", "skill_name", "skillName", "name"]) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function expandHome(value) {
  if (!value.startsWith("~/")) return value;
  return path.join(os.homedir(), value.slice(2));
}

module.exports = { buildRecord, extractSkillName };
