#!/usr/bin/env node
"use strict";

// Uninstall takes back the instructions and MCP servers the personal Library
// wrote into other agents' user-level files. This mirrors
// src/core/library-instructions.ts and src/core/library-mcp.ts so it runs
// straight from a global install without a build.

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

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Keys leading to the servers object, by the agent file the Library writes. */
function serverKeys(file) {
  if (path.basename(file) === "opencode.json") return ["mcp"];
  if (file.endsWith(path.join(".zcode", "cli", "config.json"))) return ["mcp", "servers"];
  return ["mcpServers"];
}

const HEADER = /^\s*\[([^\][]+)\]\s*(?:#.*)?$/;

function codexBlock(lines, name) {
  const own = (line) => {
    const match = HEADER.exec(line);
    const header = match ? match[1].trim() : "";
    return header === `mcp_servers.${name}` || header.startsWith(`mcp_servers.${name}.`);
  };
  const start = lines.findIndex(own);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (!/^\s*\[/.test(lines[end]) || own(lines[end]))) end += 1;
  return { start, end };
}

/** Removes the servers whose entry still equals what AgentRecall wrote; returns the new text and the names left alone. */
function withoutOwnedServers(file, text, written) {
  const kept = {};
  if (file.endsWith(".toml")) {
    let lines = text.replace(/\r\n/g, "\n").split("\n");
    for (const [name, block] of Object.entries(written)) {
      const found = codexBlock(lines, name);
      if (!found) continue;
      if (lines.slice(found.start, found.end).join("\n").trim() !== String(block).trim()) {
        kept[name] = block;
        continue;
      }
      lines = [...lines.slice(0, found.start), ...lines.slice(found.end)];
    }
    const next = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
    return { text: next ? `${next}\n` : "", kept };
  }
  const root = JSON.parse(text);
  let servers = root;
  for (const key of serverKeys(file)) servers = servers && typeof servers === "object" ? servers[key] : undefined;
  if (!servers || typeof servers !== "object") return { text, kept };
  for (const [name, entry] of Object.entries(written)) {
    if (!Object.prototype.hasOwnProperty.call(servers, name)) continue;
    if (canonical(servers[name]) !== canonical(entry)) kept[name] = entry;
    else delete servers[name];
  }
  return { text: `${JSON.stringify(root, null, 2)}\n`, kept };
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
  const mcpWritten = state.mcp && typeof state.mcp.written === "object" && state.mcp.written ? state.mcp.written : {};
  const mcpKept = {};
  for (const [file, written] of Object.entries(mcpWritten)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      mcpKept[file] = written;
      skipped.push(`${file} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    let result;
    try {
      result = withoutOwnedServers(file, text, written || {});
    } catch (error) {
      mcpKept[file] = written;
      skipped.push(`${file} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (Object.keys(result.kept).length > 0) {
      mcpKept[file] = result.kept;
      skipped.push(`${file} (MCP servers changed outside AgentRecall: ${Object.keys(result.kept).join(", ")})`);
    }
    if (result.text !== text) {
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, result.text);
      fs.renameSync(temporary, file);
      removed += 1;
    }
  }
  // Slash commands and subagents are whole files: delete each one that still has the content AgentRecall wrote.
  const files = {};
  for (const kind of ["commands", "subagents"]) {
    const record = state.files && state.files[kind] && typeof state.files[kind].written === "object" && state.files[kind].written ? state.files[kind].written : {};
    const left = {};
    for (const [file, written] of Object.entries(record)) {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        left[file] = written;
        skipped.push(`${file} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      if (text !== written) {
        skipped.push(file);
        continue;
      }
      fs.rmSync(file);
      removed += 1;
    }
    files[kind] = { enabled: [], written: left };
  }
  fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, enabled: [], written: kept, mcp: { enabled: [], written: mcpKept }, files }, null, 2)}\n`);
  const detail = skipped.length ? `Kept what was changed outside AgentRecall in: ${skipped.join("; ")}` : "";
  return { status: removed > 0 || skipped.length > 0 ? "removed" : "unchanged", detail };
}

module.exports = { removeLibraryBlocks };
