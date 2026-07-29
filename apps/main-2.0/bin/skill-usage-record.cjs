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
const crypto = require("node:crypto");

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

  // session_id and cwd come straight from the PostToolUse stdin payload. They
  // let AgentRecall link the usage record to the indexed session; transcripts
  // do not record skill invocations, so this is the only linkage source.
  const sessionId = cleanText(input.session_id);
  const cwd = cleanText(input.cwd);
  // skill_hash keys the trigger to the skill version that was active at the
  // time. Only the SKILL.md body is hashed: it is the behavioral core of a
  // skill, and a single-file read keeps the hook cheap. Plugin skills and
  // unresolvable names simply omit the field ("version unknown").
  const skillHash = skillMarkdownHash(skill, cwd);

  const record = {
    skill,
    agent: "claude",
    event: typeof input.hook_event_name === "string" ? input.hook_event_name : "PostToolUse",
    ts: new Date().toISOString(),
  };
  if (sessionId) record.session_id = sessionId;
  if (cwd) record.cwd = cwd;
  if (skillHash) record.skill_hash = skillHash;
  return record;
}

// Resolves the skill's SKILL.md (project level first, matching Claude's
// resolution order) and returns its sha256 hex, or "" when the file cannot
// be found or read. Never throws. The home directory is resolved per call so
// tests can point it at a temporary HOME.
function skillMarkdownHash(skill, cwd) {
  if (!skill || /[\\/]|\.\./.test(skill)) return "";
  const homeDir = process.env.AGENT_RECALL_TEST_HOME || os.homedir();
  const roots = [];
  if (cwd) roots.push(path.join(cwd, ".claude", "skills"));
  roots.push(path.join(homeDir, ".claude", "skills"));
  for (const root of roots) {
    try {
      const markdown = fs.readFileSync(path.join(root, skill, "SKILL.md"));
      return crypto.createHash("sha256").update(markdown).digest("hex");
    } catch {
      // Missing at this root; try the next one.
    }
  }
  return "";
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
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

module.exports = { buildRecord, extractSkillName, skillMarkdownHash };
