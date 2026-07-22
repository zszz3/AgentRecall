import { describe, expect, it, vi } from "vitest";
import type { SessionMessage, SessionSearchResult, SessionTraceEvent } from "./types";
import {
  SESSION_AGENT_STATUS_MESSAGE_WINDOW,
  analyzeIndexedSessionAgentStatus,
  analyzeSessionAgentStatus,
  type SessionAgentStatusDataSource,
} from "./session-agent-status";

function message(
  index: number,
  role: SessionMessage["role"],
  content: string,
  timestamp: string,
): SessionMessage {
  return { index, role, content, timestamp };
}

function trace(
  index: number,
  overrides: Partial<SessionTraceEvent> = {},
): SessionTraceEvent {
  return {
    index,
    kind: "tool_call",
    source: "codex",
    title: "shell_command · npm test",
    detail: JSON.stringify({ command: "npm test" }),
    timestamp: `2026-07-22T08:0${index}:00Z`,
    status: "unknown",
    ...overrides,
  };
}

describe("session Agent status analysis", () => {
  it("summarizes the latest request and de-duplicates one tool call from its ending event", () => {
    const result = analyzeSessionAgentStatus({
      session: { projectPath: "/repo", messageCount: 3 },
      messages: [
        message(0, "user", "Fix   the login flow", "2026-07-22T08:00:00Z"),
        message(1, "assistant", "Working on it", "2026-07-22T08:01:00Z"),
        message(2, "user", "Also keep the old API", "2026-07-22T08:02:00Z"),
      ],
      traceEvents: [
        trace(0, { callId: "call-1", timestamp: "2026-07-22T08:01:10Z" }),
        trace(1, {
          kind: "event",
          title: "shell · npm test",
          detail: "exit_code: 0",
          timestamp: "2026-07-22T08:01:20Z",
          callId: "call-1",
          eventType: "exec_command_end",
          status: "success",
        }),
        trace(2, {
          kind: "event",
          title: "context_compacted",
          detail: "{}",
          timestamp: "2026-07-22T08:01:30Z",
          eventType: "context_compacted",
        }),
      ],
      live: false,
      analyzedAt: new Date("2026-07-22T09:00:00Z"),
    });

    expect(result.state).toBe("waiting_agent");
    expect(result.latestUserRequest).toBe("Also keep the old API");
    expect(result.toolCallCount).toBe(1);
    expect(result.tools).toEqual([
      { name: "shell_command", count: 1, failureCount: 0, unknownCount: 0 },
    ]);
    expect(result.compactionCount).toBe(1);
    expect(result.messageCount).toBe(3);
    expect(result.traceEventCount).toBe(3);
    expect(result.analyzedAt).toBe("2026-07-22T09:00:00.000Z");
  });

  it("counts separate and id-less calls while grouping failure evidence once", () => {
    const result = analyzeSessionAgentStatus({
      session: { projectPath: "/repo", messageCount: 1 },
      messages: [message(0, "assistant", "I tried the checks.", "2026-07-22T08:00:00Z")],
      traceEvents: [
        trace(0, { callId: "call-1" }),
        trace(1, {
          kind: "event",
          title: "shell · npm test",
          callId: "call-1",
          eventType: "exec_command_end",
          status: "failure",
          detail: "exit_code: 1\nstderr: failed",
        }),
        trace(2, { callId: "call-2", title: "Read · /repo/package.json" }),
        trace(3, { callId: null, title: "web_search · Electron status bar" }),
        trace(4, { kind: "tool_result", callId: "call-2", title: "tool output" }),
        trace(5, {
          kind: "event",
          callId: "lifecycle-1",
          title: "token_count",
          eventType: "token_count",
        }),
        trace(6, {
          kind: "event",
          callId: "lifecycle-failure",
          title: "checkpoint",
          eventType: "checkpoint",
          status: "failure",
          detail: "checkpoint failed",
          timestamp: "2026-07-22T08:00:30Z",
        }),
      ],
      live: false,
      analyzedAt: new Date("2026-07-22T09:00:00Z"),
    });

    expect(result.toolCallCount).toBe(3);
    expect(result.failureCount).toBe(2);
    expect(result.latestFailure).toMatchObject({
      title: "shell_command",
      detail: "exit_code: 1 stderr: failed",
    });
    expect(result.tools).toEqual([
      { name: "Read", count: 1, failureCount: 0, unknownCount: 1 },
      { name: "shell_command", count: 1, failureCount: 1, unknownCount: 0 },
      { name: "web_search", count: 1, failureCount: 0, unknownCount: 1 },
    ]);
  });

  it("prefers live state, otherwise uses the newest terminal error or interruption", () => {
    const messages = [message(0, "assistant", "Done for now.", "2026-07-22T08:00:00Z")];
    const error = trace(0, {
      kind: "event",
      title: "error",
      detail: "Network unavailable",
      timestamp: "2026-07-22T08:01:00Z",
      eventType: "error",
      status: "failure",
    });
    const aborted = trace(1, {
      kind: "event",
      title: "turn_aborted",
      detail: "{}",
      timestamp: "2026-07-22T08:02:00Z",
      eventType: "turn_aborted",
    });

    expect(analyzeSessionAgentStatus({
      session: { projectPath: "/repo" }, messages, traceEvents: [error], live: false,
    }).state).toBe("failed");
    expect(analyzeSessionAgentStatus({
      session: { projectPath: "/repo" }, messages, traceEvents: [error, aborted], live: false,
    }).state).toBe("interrupted");
    expect(analyzeSessionAgentStatus({
      session: { projectPath: "/repo" }, messages, traceEvents: [error, aborted], live: true,
    }).state).toBe("running");
  });

  it("uses only structured planning tools and applies later explicit item updates", () => {
    const result = analyzeSessionAgentStatus({
      session: { projectPath: "/repo", messageCount: 2 },
      messages: [
        message(0, "user", "- [ ] This natural-language checkbox is not plan state", "2026-07-22T08:00:00Z"),
        message(1, "assistant", "I will track it explicitly.", "2026-07-22T08:00:30Z"),
      ],
      traceEvents: [
        trace(0, {
          title: "update_plan",
          detail: JSON.stringify({
            explanation: "Track implementation",
            plan: [
              { id: "tests", step: "Add regression tests", status: "in_progress" },
              { id: "build", step: "Verify build", status: "pending" },
            ],
          }),
        }),
        trace(1, {
          title: "update_todo_status",
          detail: JSON.stringify({ id: "tests", status: "completed" }),
        }),
        trace(2, { title: "TodoWrite", detail: "{malformed" }),
      ],
      live: false,
    });

    expect(result.todos).toEqual([
      { id: "tests", content: "Add regression tests", status: "completed" },
      { id: "build", content: "Verify build", status: "pending" },
    ]);
    expect(result.todos.some((item) => item.content.includes("checkbox"))).toBe(false);
  });

  it("skips framework meta messages and tolerates invalid timestamps", () => {
    const result = analyzeSessionAgentStatus({
      session: { projectPath: "/repo" },
      messages: [
        message(0, "user", "Actual request", "not-a-time"),
        message(1, "assistant", "Working", "also-invalid"),
        message(2, "user", "<agent_status>generated state</agent_status>", "still-invalid"),
        message(3, "user", "<system-reminder>generated reminder</system-reminder>", ""),
      ],
      traceEvents: [trace(0, { timestamp: "invalid", title: "Read · /repo/file" })],
      live: false,
    });

    expect(result.latestUserRequest).toBe("Actual request");
    expect(result.firstActivityAt).toBeNull();
    expect(result.lastActivityAt).toBeNull();
    expect(result.state).toBe("waiting_user");
  });
});

describe("indexed Session Agent status analysis", () => {
  it("reads only the message tail but always includes the complete trace", () => {
    const indexedSession = {
      sessionKey: "codex:test",
      projectPath: "/repo",
      messageCount: 500,
    } as SessionSearchResult;
    const oldTrace = trace(0, {
      title: "Read · /repo/old-file",
      timestamp: "2026-07-20T08:00:00Z",
    });
    const source: SessionAgentStatusDataSource = {
      getSession: vi.fn(() => indexedSession),
      getMessageCount: vi.fn(() => 500),
      getMessages: vi.fn(() => [message(499, "assistant", "Latest reply", "2026-07-22T08:00:00Z")]),
      getTraceEvents: vi.fn(() => [oldTrace]),
    };

    const result = analyzeIndexedSessionAgentStatus(
      source,
      indexedSession.sessionKey,
      false,
      new Date("2026-07-22T09:00:00Z"),
    );

    expect(source.getMessages).toHaveBeenCalledWith(
      indexedSession.sessionKey,
      500 - SESSION_AGENT_STATUS_MESSAGE_WINDOW,
      SESSION_AGENT_STATUS_MESSAGE_WINDOW,
    );
    expect(source.getTraceEvents).toHaveBeenCalledWith(indexedSession.sessionKey);
    expect(result).toMatchObject({ messageCount: 500, traceEventCount: 1, toolCallCount: 1 });
  });

  it("returns null when the indexed Session no longer exists", () => {
    const source: SessionAgentStatusDataSource = {
      getSession: vi.fn(() => null),
      getMessageCount: vi.fn(() => 0),
      getMessages: vi.fn(() => []),
      getTraceEvents: vi.fn(() => []),
    };

    expect(analyzeIndexedSessionAgentStatus(source, "missing", false)).toBeNull();
    expect(source.getMessages).not.toHaveBeenCalled();
    expect(source.getTraceEvents).not.toHaveBeenCalled();
  });
});
