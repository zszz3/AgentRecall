import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { syncDefaultSessionsInBatches } from "./indexer";
import { SessionStore } from "./session-store";
import { findSessionFamily } from "./session-family";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

function writeRollout(homeDir: string, name: string, rows: unknown[]): void {
  const dir = path.join(homeDir, ".codex", "sessions", "2026", "10", "12");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

describe("Codex Guardian review indexing", () => {
  it("indexes a Guardian review rollout as a child of the reviewed session", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v1-guardian-review-"));
    const db = new DatabaseSync(":memory:");
    const store = new SessionStore(db);
    try {
      writeRollout(homeDir, "rollout-2026-10-12T03-00-00-parent.jsonl", [
        {
          type: "session_meta",
          timestamp: "2026-10-12T03:00:00Z",
          payload: { id: "parent", session_id: "parent", cwd: "/repo", originator: "Codex Desktop", thread_source: "user" },
        },
        {
          type: "response_item",
          timestamp: "2026-10-12T03:00:01Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "review this change" }] },
        },
      ]);
      writeRollout(homeDir, "rollout-2026-10-12T03-18-26-guardian.jsonl", [
        // Codex's approval reviewer runs as its own thread: it owns its id and
        // names the reviewed conversation as its parent.
        {
          type: "session_meta",
          timestamp: "2026-10-12T03:18:26Z",
          payload: {
            id: "guardian",
            session_id: "parent",
            parent_thread_id: "parent",
            cwd: "/repo",
            originator: "Codex Desktop",
            thread_source: "guardian_review",
            source: { subagent: { other: "guardian" } },
          },
        },
        {
          type: "response_item",
          timestamp: "2026-10-12T03:18:27Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "The following is the Codex agent history whose request action you are assessing." }],
          },
        },
      ]);

      const status = await syncDefaultSessionsInBatches(store, { batchSize: 4, loadOptions: { homeDir } });
      expect(status.indexed).toBe(2);

      expect(store.getSession("codex:guardian")).toMatchObject({
        rawId: "guardian",
        isSubagent: true,
        parentSessionId: "parent",
        originalTitle: "Guardian review",
        source: "codex-app",
      });

      const visible = store.searchSessions({ limit: 50, excludeSubagents: true });
      expect(visible.map((row) => row.rawId).sort()).toEqual(["parent"]);

      const all = store.searchSessions({ limit: 50 });
      expect(all.map((row) => row.rawId).sort()).toEqual(["guardian", "parent"]);

      const family = findSessionFamily(db, "codex:parent");
      expect(family.children.map((node) => node.sessionKey)).toEqual(["codex:guardian"]);
      expect(family.children[0]?.title).toBe("Guardian review");
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120_000);
});
