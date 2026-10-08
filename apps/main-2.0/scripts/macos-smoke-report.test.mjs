import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runMacosVerification } from "./macos-smoke-report.mjs";

async function previousReport(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-smoke-report-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "smoke-result.json");
  await fs.writeFile(reportPath, JSON.stringify({ status: "PASS", previousRun: true }));
  return reportPath;
}

test("removes a previous PASS before verification starts", async (t) => {
  const reportPath = await previousReport(t);
  const report = { status: "PASS", currentRun: true };
  assert.deepEqual(await runMacosVerification(reportPath, async () => {
    await assert.rejects(fs.access(reportPath), { code: "ENOENT" });
    return report;
  }), report);
  assert.deepEqual(JSON.parse(await fs.readFile(reportPath, "utf8")), report);
});

test("verification failure leaves no PASS report", async (t) => {
  const reportPath = await previousReport(t);
  const failure = new Error("readiness failed");
  await assert.rejects(runMacosVerification(reportPath, async () => {
    throw failure;
  }), (error) => error === failure);
  await assert.rejects(fs.access(reportPath), { code: "ENOENT" });
});

test("cleanup failure after a successful verification leaves no PASS report", async (t) => {
  const reportPath = await previousReport(t);
  const failure = new Error("cleanup unconfirmed");
  await assert.rejects(runMacosVerification(reportPath, async () => {
    try {
      return { status: "PASS" };
    } finally {
      await assert.rejects(fs.access(reportPath), { code: "ENOENT" });
      throw failure;
    }
  }), (error) => error === failure);
  await assert.rejects(fs.access(reportPath), { code: "ENOENT" });
});

test("publishes PASS only after asynchronous cleanup completes", async (t) => {
  const reportPath = await previousReport(t);
  const cleanupMarker = path.join(path.dirname(reportPath), "cleanup-complete");
  const report = { status: "PASS" };
  await runMacosVerification(reportPath, async () => {
    try {
      return report;
    } finally {
      await assert.rejects(fs.access(reportPath), { code: "ENOENT" });
      await fs.writeFile(cleanupMarker, "complete");
    }
  });
  assert.equal(await fs.readFile(cleanupMarker, "utf8"), "complete");
  assert.deepEqual(JSON.parse(await fs.readFile(reportPath, "utf8")), report);
});
