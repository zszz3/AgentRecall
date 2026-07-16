#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_OUTPUT = path.join(os.homedir(), ".claude", "statusline-snapshot.json");
const outputPath = expandHome(process.env.AGENT_RECALL_CLAUDE_STATUSLINE || DEFAULT_OUTPUT);

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
  if (stdin.length > 1024 * 1024) {
    process.stderr.write("Claude statusline input is too large.\n");
    process.exit(1);
  }
});

process.stdin.on("end", () => {
  try {
    const input = stdin.trim() ? JSON.parse(stdin) : {};
    const snapshot = buildSnapshot(input, readExistingSnapshot());
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    writeJsonAtomic(outputPath, snapshot);
    process.stdout.write(formatStatusline(snapshot));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not write Claude statusline snapshot: ${message}\n`);
    process.exit(1);
  }
});

function buildSnapshot(input, previous) {
  const snapshot = {
    source: "agent-recall-statusline",
    updated_at: new Date().toISOString(),
  };

  // Claude Code does not include `plan`/`rate_limits` on every statusLine render (early renders and
  // some refreshes omit them). Carry the last known values forward so a payload without quota data
  // does not blank out the panel; quota.ts marks them stale once resets_at passes.
  const plan = stringField(input, "plan") || stringField(input, "subscription_plan") || stringField(previous, "plan");
  if (plan) snapshot.plan = plan;

  const rateLimits = objectField(input, "rate_limits");
  const prevRateLimits = objectField(previous, "rate_limits");
  const five = mergeWindow(objectField(rateLimits, "five_hour"), objectField(prevRateLimits, "five_hour"));
  const seven = mergeWindow(objectField(rateLimits, "seven_day"), objectField(prevRateLimits, "seven_day"));
  if (five || seven) {
    snapshot.rate_limits = {};
    if (five) snapshot.rate_limits.five_hour = five;
    if (seven) snapshot.rate_limits.seven_day = seven;
  }

  return snapshot;
}

function readExistingSnapshot() {
  try {
    const raw = fs.readFileSync(outputPath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeWindow(value) {
  if (!value) return null;
  const window = {};
  copyNumber(value, window, "used_percentage");
  copyNumber(value, window, "remaining_percentage");
  copyNumber(value, window, "resets_at");
  return Object.keys(window).length > 0 ? window : null;
}

// Pick the window to persist. A render can report a window without its usage percentage
// (early renders and bypass-permissions sessions do this); such a window is not actionable —
// quota.ts drops a percentage-less window and the panel goes blank. So a percentage-less
// incoming window must never overwrite the last known good value: the incoming window only
// wins when it actually carries a percentage; otherwise we keep the previous one.
function mergeWindow(incoming, previous) {
  const current = normalizeWindow(incoming);
  if (windowHasPercentage(current)) return current;
  const prev = normalizeWindow(previous);
  if (windowHasPercentage(prev)) return prev;
  return current || prev;
}

function windowHasPercentage(window) {
  return Boolean(window && (typeof window.used_percentage === "number" || typeof window.remaining_percentage === "number"));
}

function copyNumber(source, target, key) {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function objectField(value, key) {
  const field = value && typeof value === "object" ? value[key] : undefined;
  return field && typeof field === "object" && !Array.isArray(field) ? field : null;
}

function stringField(value, key) {
  const field = value && typeof value === "object" ? value[key] : undefined;
  return typeof field === "string" && field.trim() ? field.trim() : "";
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function formatStatusline(snapshot) {
  const pieces = [];
  const fiveHour = snapshot.rate_limits && snapshot.rate_limits.five_hour;
  const sevenDay = snapshot.rate_limits && snapshot.rate_limits.seven_day;
  if (fiveHour && typeof fiveHour.used_percentage === "number") pieces.push(`5h ${Math.round(100 - fiveHour.used_percentage)}% left`);
  if (sevenDay && typeof sevenDay.used_percentage === "number") pieces.push(`7d ${Math.round(100 - sevenDay.used_percentage)}% left`);
  return pieces.length > 0 ? `${pieces.join(" | ")}\n` : "Claude quota pending\n";
}

function expandHome(value) {
  if (!value.startsWith("~/")) return value;
  return path.join(os.homedir(), value.slice(2));
}
