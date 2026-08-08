import { describe, expect, it } from "vitest";
import { formatSessionMarkdown } from "./format-session";
import type { IndexedSession, SessionMessage, SessionTraceEvent } from "./types";

const session: IndexedSession = {
  sessionKey: "codex:abc",
  rawId: "abc",
  source: "codex-cli",
  projectPath: "/repo",
  filePath: "/tmp/rollout.jsonl",
  originalTitle: "Test Session",
  firstQuestion: "Test Session",
  timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
  fileMtimeMs: 10,
  fileSize: 100,
  prUrl: null,
  prNumber: null,
};

const messages: SessionMessage[] = [
  { role: "user", content: "run tests", timestamp: "2026-06-01T10:00:00Z", index: 0 },
  { role: "assistant", content: "I will run them.", timestamp: "2026-06-01T10:01:00Z", index: 1 },
];

const traceEvents: SessionTraceEvent[] = [{
  index: 0,
  kind: "tool_call",
  source: "codex",
  title: "shell_command · npm test",
  detail: "npm test",
  timestamp: "2026-06-01T10:02:00Z",
  callId: "call-1",
}];

describe("formatSessionMarkdown", () => {
  it("includes Tool Trace in a complete export", () => {
    expect(formatSessionMarkdown(session, messages, traceEvents, {
      includeToolTrace: true,
    })).toContain("## Tool Trace");
  });

  it("keeps the conversation while excluding Tool Trace", () => {
    const markdown = formatSessionMarkdown(session, messages, traceEvents, {
      includeToolTrace: false,
    });

    expect(markdown).toContain("I will run them.");
    expect(markdown).not.toContain("## Tool Trace");
    expect(markdown).not.toContain("shell_command · npm test");
  });
});
