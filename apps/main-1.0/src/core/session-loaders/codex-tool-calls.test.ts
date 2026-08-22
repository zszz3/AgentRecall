import { describe, expect, it } from "vitest";
import {
  collectCodexToolCallObservations,
  correlateCodexToolCalls,
  extractCodexStructuredToolCalls,
} from "./codex-tool-calls";

function responseRow(payload: Record<string, unknown>, timestamp = "2026-08-01T10:00:00Z"): unknown {
  return { type: "response_item", timestamp, payload };
}

function completedRow(item: unknown, turnId = "turn-1", timestamp = "2026-08-01T10:00:05Z"): unknown {
  return {
    type: "event_msg",
    timestamp,
    payload: { type: "item_completed", turn_id: turnId, item },
  };
}

describe("codex structured tool calls", () => {
  it("normalizes top-level response_item calls and parses JSON arguments once", () => {
    const calls = extractCodexStructuredToolCalls([
      responseRow({
        type: "function_call",
        name: "read",
        namespace: "skills",
        call_id: "call-1",
        arguments: JSON.stringify({ package: "e0/search" }),
      }),
      responseRow({
        type: "custom_tool_call",
        name: "exec",
        call_id: "call-2",
        input: "await tools.exec_command({ cmd: \"git status\" });",
      }),
      responseRow({
        type: "local_shell_call",
        call_id: "call-3",
        action: { type: "command", command: ["ls", "-la"] },
      }),
      responseRow({ type: "tool_search_call", call_id: "call-4", execution: "search", arguments: "raw" }),
      responseRow({ type: "tool_search_call", call_id: "call-5" }),
    ]);

    expect(calls.map((call) => call.canonicalName)).toEqual([
      "skills.read",
      "exec",
      "shell",
      "search",
      "tool_search",
    ]);
    expect(calls[0]).toMatchObject({
      callId: "call-1",
      input: { package: "e0/search" },
      status: "unknown",
      executionEvidence: "recorded-request",
    });
    expect(calls[0].evidence).toHaveLength(1);
    expect(calls[0].evidence[0]).toMatchObject({ status: "requested", evidence: "response-item" });
    expect(calls[1].input).toBe("await tools.exec_command({ cmd: \"git status\" });");
    expect(calls[2].input).toEqual({ type: "command", command: ["ls", "-la"] });
    expect(calls[3].input).toBe("raw");
  });

  it("keeps unparsable function_call arguments as the raw string", () => {
    const calls = extractCodexStructuredToolCalls([
      responseRow({ type: "function_call", name: "shell_command", call_id: "call-1", arguments: "{not json" }),
    ]);
    expect(calls[0].input).toBe("{not json");
  });

  it("ignores records that are not tool calls", () => {
    const calls = extractCodexStructuredToolCalls([
      { type: "session_meta", timestamp: "2026-08-01T10:00:00Z", payload: { id: "s1", history_mode: "paginated" } },
      responseRow({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "please run skills.read and the shell tool" }],
      }),
      responseRow({ type: "function_call_output", call_id: "call-1", output: "{\"ok\":true}" }),
      responseRow({ type: "web_search_call", call_id: "call-2", action: { type: "search" } }),
      completedRow({ type: "AgentMessage", id: "msg-1" }),
      completedRow({ type: "WebSearch", id: "web-1", query: "codex" }),
      "not a record",
      null,
      [1, 2],
    ]);
    expect(calls).toEqual([]);
  });

  it("recovers runtime evidence from paginated item_completed records", () => {
    const observations = collectCodexToolCallObservations([
      completedRow({
        type: "CommandExecution",
        id: "exec-1",
        command: ["git", "status"],
        cwd: "/repo",
        parsed_cmd: [],
        status: "completed",
        exit_code: 0,
      }),
      completedRow({ type: "CommandExecution", id: "exec-2", command: ["cargo", "test"], cwd: null, exit_code: 101 }),
      completedRow({ type: "CommandExecution", id: "exec-3", command: ["rm", "-rf", "/"], status: "declined" }),
      completedRow({ type: "CommandExecution", id: "exec-4", command: ["sleep", "5"], status: "in_progress" }),
      completedRow({
        type: "DynamicToolCall",
        id: "dyn-1",
        namespace: "skills",
        tool: "read",
        arguments: { package: "e0/search" },
        status: "completed",
        success: true,
      }),
      completedRow({ type: "DynamicToolCall", id: "dyn-2", namespace: null, tool: "exec", arguments: "...", success: false }),
      completedRow({ type: "McpToolCall", id: "mcp-1", server: "docs", tool: "search", arguments: { query: "session" }, status: "completed" }),
    ]);

    expect(observations.map((observation) => observation.evidence)).toEqual(
      Array.from({ length: 7 }, () => "item-completed"),
    );
    const calls = correlateCodexToolCalls(observations);
    expect(calls.map((call) => [call.canonicalName, call.status, call.executionEvidence])).toEqual([
      ["shell", "completed", "runtime-confirmed"],
      ["shell", "failed", "runtime-confirmed"],
      ["shell", "declined", "runtime-confirmed"],
      ["shell", "unknown", "runtime-confirmed"],
      ["skills.read", "completed", "runtime-confirmed"],
      ["exec", "failed", "runtime-confirmed"],
      ["mcp__docs.search", "completed", "runtime-confirmed"],
    ]);
    expect(calls[0]).toMatchObject({ callId: "exec-1", turnId: "turn-1", cwd: "/repo" });
    expect(calls[0].input).toEqual({ command: "git status", cwd: "/repo", parsedCommand: [], exitCode: 0 });
    expect(calls[0].evidence[0].rawName).toBe("shell");
  });

  it("decodes single-key item wrappers and bare item_completed rows", () => {
    const calls = extractCodexStructuredToolCalls([
      completedRow({
        CommandExecution: { id: "exec-1", command: ["ls"], cwd: "C:\\repo", status: "completed", exit_code: 0 },
      }),
      {
        type: "item_completed",
        timestamp: "2026-08-01T10:00:07Z",
        payload: { turn_id: "turn-2", item: { type: "McpToolCall", id: "mcp-1", server: "docs", tool: "get" } },
      },
    ]);
    expect(calls.map((call) => call.canonicalName)).toEqual(["shell", "mcp__docs.get"]);
    expect(calls[0].cwd).toBe("C:\\repo");
    expect(calls[1].turnId).toBe("turn-2");
  });

  it("merges request and completion records of the same call exactly once", () => {
    const calls = extractCodexStructuredToolCalls([
      responseRow({
        type: "function_call",
        name: "shell_command",
        call_id: "command-1",
        arguments: JSON.stringify({ command: "ls -la" }),
      }),
      completedRow({
        type: "CommandExecution",
        id: "command-1",
        command: ["ls", "-la"],
        cwd: "/repo",
        status: "completed",
        exit_code: 0,
      }),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      callId: "command-1",
      canonicalName: "shell",
      cwd: "/repo",
      status: "completed",
      executionEvidence: "runtime-confirmed",
    });
    expect(calls[0].input).toEqual({ command: "ls -la", cwd: "/repo", parsedCommand: null, exitCode: 0 });
    expect(calls[0].evidence).toHaveLength(2);
    expect(calls[0].evidence.map((observation) => observation.evidence)).toEqual([
      "response-item",
      "item-completed",
    ]);
    // The request timestamp survives the merge as the call's earliest evidence.
    expect(Math.min(...calls[0].evidence.map((observation) => observation.timestamp)))
      .toBe(Date.parse("2026-08-01T10:00:00Z"));
  });

  it("keeps identical but independent calls separate", () => {
    const arguments_ = JSON.stringify({ command: "cat SKILL.md" });
    const calls = extractCodexStructuredToolCalls([
      responseRow({ type: "function_call", name: "shell_command", call_id: "cmd-1", arguments: arguments_ }),
      responseRow({ type: "function_call", name: "shell_command", call_id: "cmd-2", arguments: arguments_ }),
      responseRow({ type: "function_call", name: "shell_command", arguments: arguments_ }),
      responseRow({ type: "function_call", name: "shell_command", arguments: arguments_ }),
    ]);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.executionEvidence === "recorded-request")).toBe(true);
    expect(calls.map((call) => call.callId)).toEqual(["cmd-1", "cmd-2", null, null]);
  });

  it("prefers completion timing when only the completion record exists", () => {
    const completedAtMs = Date.parse("2026-08-01T10:00:09Z");
    const calls = extractCodexStructuredToolCalls([
      {
        type: "event_msg",
        timestamp: "2026-08-01T10:00:10Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          completed_at_ms: completedAtMs,
          item: { type: "CommandExecution", id: "exec-1", command: ["ls"], status: "completed", exit_code: 0 },
        },
      },
    ]);
    expect(calls[0].evidence[0].timestamp).toBe(completedAtMs);
  });
});
