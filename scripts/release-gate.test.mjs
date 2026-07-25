import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  createEvidenceTemplate,
  evaluateReleaseGate,
  RELEASE_GATE_DEFINITIONS,
  runReleaseGateCli,
} from "./release-gate.mjs";

const temporaryDirectories = new Set();

after(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function completePassingEvidence() {
  const digest = "a".repeat(64);
  const gates = Object.fromEntries(
    RELEASE_GATE_DEFINITIONS.map((definition) => [
      definition.id,
      {
        status: "PASS",
        observedAt: "2026-07-25T00:00:00.000Z",
        evidence: `synthetic-report.json#${definition.id}`,
      },
    ]),
  );

  Object.assign(gates["install.macos-arm64"], { platform: "macos", arch: "arm64" });
  Object.assign(gates["install.macos-x64"], { platform: "macos", arch: "x64" });
  Object.assign(gates["install.windows-x64"], { platform: "windows", arch: "x64" });
  gates["startup.first-window-3s"].metrics = { firstUsableWindowMs: 2999 };
  gates["search.10k-p95-200ms"].dataset = { sessions: 10_000 };
  gates["search.10k-p95-200ms"].metrics = { queryP95Ms: 200 };
  gates["config.persistence-isolation"].artifacts = [
    { label: "synthetic-claude-config", beforeSha256: digest, afterSha256: digest },
  ];
  gates["privacy.upstream-files-unchanged"].artifacts = [
    { label: "synthetic-session", beforeSha256: digest, afterSha256: digest },
  ];
  gates["network.disabled-means-off"].settings = { updatesDisabled: true };
  gates["network.disabled-means-off"].metrics = {
    advancedTasksStarted: 0,
    unexpectedRequests: 0,
  };
  gates["quality.no-p0-p1"].metrics = { p0Open: 0, p1Open: 0 };

  return { schemaVersion: 1, release: "1.0.0-rc.1", gates };
}

test("missing evidence stays BLOCKED instead of fabricating a pass", () => {
  const report = evaluateReleaseGate({}, { generatedAt: "2026-07-25T00:00:00.000Z" });
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.counts.PASS, 0);
  assert.equal(report.counts.FAIL, 0);
  assert.equal(report.counts.BLOCKED, RELEASE_GATE_DEFINITIONS.length);
});

test("accepts complete synthetic evidence at the documented thresholds", () => {
  const report = evaluateReleaseGate(completePassingEvidence(), {
    generatedAt: "2026-07-25T00:00:00.000Z",
  });
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.counts, {
    PASS: RELEASE_GATE_DEFINITIONS.length,
    FAIL: 0,
    BLOCKED: 0,
  });
});

test("turns unsupported performance claims into explicit failures", () => {
  const evidence = completePassingEvidence();
  evidence.gates["startup.first-window-3s"].metrics.firstUsableWindowMs = 3001;
  evidence.gates["search.10k-p95-200ms"].dataset.sessions = 9999;
  evidence.gates["search.10k-p95-200ms"].metrics.queryP95Ms = 201;

  const report = evaluateReleaseGate(evidence);
  assert.equal(report.status, "FAIL");
  assert.match(
    report.gates.find((gate) => gate.id === "startup.first-window-3s").reason,
    /above 3000 ms/,
  );
  assert.match(
    report.gates.find((gate) => gate.id === "search.10k-p95-200ms").reason,
    /below 10000.*above 200 ms/,
  );
});

test("requires unchanged synthetic hashes and an idle, offline observation", () => {
  const evidence = completePassingEvidence();
  evidence.gates["privacy.upstream-files-unchanged"].artifacts[0].afterSha256 = "b".repeat(64);
  evidence.gates["network.disabled-means-off"].metrics.unexpectedRequests = 1;

  const report = evaluateReleaseGate(evidence);
  assert.equal(report.status, "FAIL");
  assert.match(
    report.gates.find((gate) => gate.id === "privacy.upstream-files-unchanged").reason,
    /changed during the test/,
  );
  assert.match(
    report.gates.find((gate) => gate.id === "network.disabled-means-off").reason,
    /unexpectedRequests must be 0/,
  );
});

test("writes a safe BLOCKED template only to the explicitly requested path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-recall-release-gate-"));
  temporaryDirectories.add(directory);
  const templatePath = path.join(directory, "evidence.json");
  let output = "";

  const exitCode = await runReleaseGateCli(
    ["--write-template", templatePath, "--release", "1.0.0-rc.2"],
    { stdout: { write: (value) => { output += value; } } },
  );

  assert.equal(exitCode, 0);
  assert.match(output, /BLOCKED evidence template/);
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  assert.deepEqual(template, createEvidenceTemplate("1.0.0-rc.2"));
  assert.ok(
    Object.values(template.gates).every((gate) => gate.status === "BLOCKED"),
  );
});

test("supports machine-readable JSON output without reading a default user path", async () => {
  let output = "";
  const exitCode = await runReleaseGateCli(
    ["--format", "json"],
    { stdout: { write: (value) => { output += value; } } },
  );

  assert.equal(exitCode, 2);
  const report = JSON.parse(output);
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.gates.length, RELEASE_GATE_DEFINITIONS.length);

  const source = await readFile(new URL("./release-gate.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /homedir\s*\(/);
  assert.doesNotMatch(source, /process\.env\.(HOME|USERPROFILE)/);
});
