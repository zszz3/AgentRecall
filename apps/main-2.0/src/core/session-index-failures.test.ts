import { describe, expect, it } from "vitest";
import { indexFailureFingerprint, SessionIndexFailures } from "./session-index-failures";
import type { IndexedSession } from "./types";

const session: IndexedSession = {
  sessionKey: "codex:failed", rawId: "failed", source: "codex-app",
  projectPath: "/fixture", filePath: "/fixture/session.jsonl",
  originalTitle: "Test", firstQuestion: "Test", timestamp: 1,
  fileMtimeMs: 1, fileSize: 10, prUrl: null, prNumber: null,
};
const diagnostic = {
  source: session.source, sessionKey: session.sessionKey, filePath: session.filePath,
  error: { name: "Error", message: "write failed", stack: null },
};

describe("session indexing backoff", () => {
  it("preserves growing backoff across ordered scans with more than 1,000 failures", () => {
    let now = 0;
    const state = new SessionIndexFailures(() => now);
    const sources = Array.from({ length: 1_001 }, (_, index): IndexedSession => ({
      ...session, sessionKey: `codex:failed-${index}`, filePath: `/fixture/session-${index}.jsonl`,
    }));
    const scan = () => {
      let attempts = 0;
      for (const source of sources) {
        if (state.deferred(source)) continue;
        state.record(source, { ...diagnostic, sessionKey: source.sessionKey, filePath: source.filePath });
        attempts++;
      }
      return attempts;
    };

    expect(scan()).toBe(sources.length);
    now = 15_000;
    expect(scan()).toBe(0);
    now = 30_000;
    expect(scan()).toBe(sources.length);
    now = 60_000;
    expect(scan()).toBe(0);
    now = 90_000;
    expect(scan()).toBe(sources.length);
    now = 150_000;
    expect(scan()).toBe(0);
    // Once failures reach the 15-minute cap, a 10-minute scheduled scan must
    // defer them even when the failure population exceeds the old cache limit.
    for (const minutes of [10, 20, 30]) {
      now = minutes * 60_000;
      expect(scan()).toBe(sources.length);
    }
    now = 40 * 60_000;
    expect(scan()).toBe(0);
    now = 45 * 60_000;
    expect(scan()).toBe(sources.length);
  });

  it.each([
    { source: "codex-cli" as const },
    { filePath: "/fixture/moved.jsonl" },
    { fileMtimeMs: 2 },
    { fileSize: 11 },
  ])("immediately retries and resets backoff after source changes: %j", (change) => {
    let now = 0;
    const state = new SessionIndexFailures(() => now);
    state.record(session, diagnostic);
    now = 30_000;
    state.record(session, diagnostic);
    now = 40_000;
    const changed = { ...session, ...change };
    expect(state.deferred(session)).toBeDefined();
    expect(state.deferred(changed)).toBeUndefined();
    state.record(changed, { ...diagnostic, source: changed.source, filePath: changed.filePath });
    now = 69_999;
    expect(state.deferred(changed)).toBeDefined();
    now = 70_000;
    expect(state.deferred(changed)).toBeUndefined();
  });

  it("resets the delay and diagnostic fingerprint for a new metadata dependency revision", () => {
    let now = 0;
    const state = new SessionIndexFailures(() => now);
    const first = state.record(session, diagnostic, 100);
    now = 30_000;
    state.record(session, diagnostic, 100);
    now = 40_000;
    expect(state.deferred(session, 100)).toBeDefined();
    expect(state.deferred(session, 200)).toBeUndefined();

    const changed = state.record(session, diagnostic, 200);
    expect(changed.revision).toMatchObject({ dependencyMtimeMs: 200 });
    expect(indexFailureFingerprint(changed)).not.toBe(indexFailureFingerprint(first));
    now = 69_999;
    expect(state.deferred(session, 200)).toBeDefined();
    now = 70_000;
    expect(state.deferred(session, 200)).toBeUndefined();
  });

  it("retains the diagnostic write result only for the current failure", () => {
    const state = new SessionIndexFailures(() => 0);
    state.record(session, diagnostic);
    expect(state.hasWrittenDiagnostic(session.sessionKey)).toBe(false);
    state.markDiagnosticWritten(session.sessionKey);
    expect(state.hasWrittenDiagnostic(session.sessionKey)).toBe(true);
    state.record(session, diagnostic);
    expect(state.hasWrittenDiagnostic(session.sessionKey)).toBe(false);
    state.markDiagnosticWritten(session.sessionKey);
    state.recovered(session.sessionKey);
    expect(state.hasWrittenDiagnostic(session.sessionKey)).toBe(false);
    state.markDiagnosticWritten(session.sessionKey);
    expect(state.hasWrittenDiagnostic(session.sessionKey)).toBe(false);
  });

  it("prunes disappeared sources while retaining observed sessions and snapshot-skipped files", () => {
    const state = new SessionIndexFailures(() => 0);
    const sources = ["observed", "snapshot-skipped", "removed"].map((name): IndexedSession => ({
      ...session, sessionKey: `codex:${name}`, filePath: `/fixture/${name}.jsonl`,
    }));
    for (const source of sources) {
      state.record(source, { ...diagnostic, sessionKey: source.sessionKey, filePath: source.filePath });
      state.markDiagnosticWritten(source.sessionKey);
    }

    state.pruneUnseenSources(new Set([sources[1].filePath]), new Set([sources[0].sessionKey]));

    expect(state.deferred(sources[0])).toBeDefined();
    expect(state.deferred(sources[1])).toBeDefined();
    expect(state.hasWrittenDiagnostic(sources[0].sessionKey)).toBe(true);
    expect(state.hasWrittenDiagnostic(sources[1].sessionKey)).toBe(true);
    expect(state.deferred(sources[2])).toBeUndefined();
    expect(state.hasWrittenDiagnostic(sources[2].sessionKey)).toBe(false);

    state.pruneUnseenSources(new Set(), new Set());
    expect(state.deferred(sources[0])).toBeUndefined();
    expect(state.deferred(sources[1])).toBeUndefined();
  });

  it("backs off unchanged failures, retries changed revisions and resets after recovery/restart", () => {
    let now = 0;
    const state = new SessionIndexFailures(() => now);
    state.record(session, diagnostic);
    expect(state.deferred(session)).toMatchObject(diagnostic);
    expect(state.deferred({ ...session, fileMtimeMs: 2 })).toBeUndefined();
    expect(state.deferred({ ...session, fileSize: 11 })).toBeUndefined();
    now = 30_000;
    expect(state.deferred(session)).toBeUndefined();
    state.record(session, diagnostic);
    now = 60_000;
    expect(state.deferred(session)).toBeDefined();
    now = 90_000;
    expect(state.deferred(session)).toBeUndefined();
    state.record(session, diagnostic);
    expect(new SessionIndexFailures(() => now).deferred(session)).toBeUndefined();
    state.recovered(session.sessionKey);
    expect(state.deferred(session)).toBeUndefined();
    state.record(session, diagnostic);
    now += 30_000;
    expect(state.deferred(session)).toBeUndefined();
  });
});
