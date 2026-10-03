import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { startPostgresRuntime } from "../../src/main/postgres/managed-postgres";
import { PostgresDatabase } from "../../src/core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../src/core/postgres/schema";
import { SessionStore } from "../../src/core/session-store";
import { syncDefaultSessionsInBatches } from "../../src/core/indexer";
import { LocalSessionIndexService } from "../../src/main/services/local-session-index-service";

// Run separately after the V2 build, with an isolated HOME and npm prefix.
// Uses a real, temporary PostgreSQL runtime and the production worker bundle.
test("compares foreground stalls during tool-session indexing and worker indexing", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-startup-index-"));
  const userDataPath = path.join(homeDir, "app-data");
  const runtime = await startPostgresRuntime({ userDataPath, environment: {} });
  const database = PostgresDatabase.connect(runtime.connectionUrl, { migrations: POSTGRES_MIGRATIONS });
  const store = new SessionStore(database, database.initialize());
  const worker = new LocalSessionIndexService(path.resolve("out/main/session-index-worker.js"), {
    userDataPath, connectionUrl: runtime.connectionUrl,
  });
  const results: unknown[] = [];
  const dir = path.join(homeDir, ".codex", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout-tools.jsonl");
  let sequence = 0;
  const row = (type: string, payload: unknown) => JSON.stringify({
    type, timestamp: new Date(Date.parse("2026-06-01T10:00:00Z") + sequence++ * 1000).toISOString(), payload,
  });
  const rows = [row("session_meta", { id: "startup-tools", cwd: "/synthetic" })];
  const turns = 10000;
  for (let index = 0; index < turns; index++) {
    rows.push(
      row("event_msg", { type: "task_started", turn_id: `turn-${index}` }),
      row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `question ${index}` }] }),
      row("response_item", { type: "function_call", call_id: `call-${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: "synthetic command" }) }),
      row("response_item", { type: "function_call_output", call_id: `call-${index}`, output: `output ${index} ${"x".repeat(4096)}` }),
      row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${index}` }] }),
      row("event_msg", { type: "task_complete", turn_id: `turn-${index}` }),
    );
  }
  const original = rows.join("\n") + "\n";
  const appended = row("event_msg", { type: "task_started", turn_id: "next" }) + "\n"
    + row("response_item", { type: "function_call", call_id: "next-call", name: "exec_command", arguments: "{}" }) + "\n"
    + row("response_item", { type: "function_call_output", call_id: "next-call", output: "next output" }) + "\n";
  const measure = async (mode: string, phase: string, run: () => Promise<unknown>) => {
    const gaps: number[] = [];
    let previous = performance.now();
    const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const start = performance.now();
    try {
      const status = await run();
      expect(status).toMatchObject({ error: null, indexed: 1 });
      const elapsedMs = performance.now() - start;
      await new Promise((resolve) => setTimeout(resolve, 20));
      results.push({ mode, phase, turns, elapsedMs: Math.round(elapsedMs), maxForegroundGapMs: Math.round(Math.max(...gaps)), ticks: gaps.length });
    } finally {
      clearInterval(timer);
    }
  };
  const digest = async () => createHash("sha256").update(JSON.stringify({
    messages: await store.getAllMessages("codex:startup-tools"),
    traces: await store.getTraceEvents("codex:startup-tools"),
    turns: await store.listSessionTurns("codex:startup-tools"),
  })).digest("hex");
  try {
    await database.initialize();
    let baseline = "";
    for (const mode of ["inline", "worker"] as const) {
      await database.query("truncate agent_recall.sessions cascade");
      fs.writeFileSync(file, original);
      const run = () => mode === "inline"
        ? syncDefaultSessionsInBatches(store, { loadOptions: { homeDir }, batchSize: 50, timeBudgetMs: 8 })
        : worker.run({ homeDir }, false, { onProgress: () => {}, onEnvironmentsChanged: () => {} });
      await measure(mode, "cold", run);
      fs.appendFileSync(file, appended);
      await measure(mode, "tool-append", run);
      if (mode === "inline") baseline = await digest();
      else expect(await digest()).toBe(baseline);
    }
    console.log("STARTUP_INDEX_WORKER_EXPERIMENT", JSON.stringify(results));
  } finally {
    await worker.stop();
    await store.close();
    await runtime.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}, 180000);
