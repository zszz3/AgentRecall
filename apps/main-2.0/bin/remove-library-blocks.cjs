#!/usr/bin/env node
"use strict";

// Uninstall takes back the instructions the personal Library wrote into other
// agents' user-level files. This mirrors src/core/library-instructions.ts so it
// runs straight from a global install without a build.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BEGIN = "<!-- agentrecall:library begin -->";
const END = "<!-- agentrecall:library end -->";

function libraryRoot(homeDir) {
  return path.join(homeDir, ".agent-recall-v2", "library");
}

function count(text, marker) {
  return text.split(marker).length - 1;
}

/** The file without its Library block, or null when the block is missing, broken or not the body AgentRecall wrote. */
function withoutOwnedBlock(text, written) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (count(normalized, BEGIN) !== 1 || count(normalized, END) !== 1) return null;
  const start = normalized.indexOf(BEGIN);
  const end = normalized.indexOf(END);
  if (end < start) return null;
  if (normalized.slice(start + BEGIN.length, end).trim() !== written.trim()) return null;
  const before = normalized.slice(0, start).replace(/\n+$/, "");
  const after = normalized.slice(end + END.length).replace(/^\n+/, "").replace(/\n+$/, "");
  const parts = [before, after].filter((part) => part.trim() !== "");
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

function removeLibraryBlocks(options = {}) {
  const homeDir = options.homeDir || process.env.AGENT_RECALL_TEST_HOME || os.homedir();
  const stateFile = path.join(libraryRoot(homeDir), "state.json");
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "unchanged", detail: "" };
    return { status: "error", detail: `Could not read ${stateFile}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!state || state.schemaVersion !== 1 || typeof state.written !== "object" || state.written === null) {
    return { status: "error", detail: `${stateFile} has an unknown format; no agent file was changed.` };
  }
  const kept = {};
  const skipped = [];
  let removed = 0;
  for (const [file, written] of Object.entries(state.written)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      kept[file] = written;
      skipped.push(`${file} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const next = typeof written === "string" ? withoutOwnedBlock(text, written) : null;
    if (next === null) {
      kept[file] = written;
      skipped.push(`${file} (its Library block was changed outside AgentRecall)`);
      continue;
    }
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, next);
    fs.renameSync(temporary, file);
    removed += 1;
  }
  fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, enabled: [], written: kept }, null, 2)}\n`);
  const detail = skipped.length ? `Kept the Library block in: ${skipped.join("; ")}` : "";
  return { status: removed > 0 || skipped.length > 0 ? "removed" : "unchanged", detail };
}

module.exports = { removeLibraryBlocks };
