import { describe, expect, it } from "vitest";
import {
  CodexToolCallCollector,
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
      "exec_command",
      "exec_command",
      "tool_search",
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
    expect(calls[2]).toMatchObject({
      parentCallId: "call-2",
      input: { cmd: "git status" },
      executionEvidence: "static-only",
    });
    expect(calls[3].input).toEqual({ type: "command", command: ["ls", "-la"] });
    expect(calls[4].input).toBe("raw");
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
      ["exec_command", "completed", "runtime-confirmed"],
      ["exec_command", "failed", "runtime-confirmed"],
      ["exec_command", "declined", "runtime-confirmed"],
      ["exec_command", "unknown", "runtime-confirmed"],
      ["skills.read", "completed", "runtime-confirmed"],
      ["exec", "failed", "runtime-confirmed"],
      ["mcp__docs.search", "completed", "runtime-confirmed"],
    ]);
    expect(calls[0]).toMatchObject({ callId: "exec-1", turnId: "turn-1", cwd: "/repo" });
    expect(calls[0].input).toEqual({
      cmd: "git status",
      command: ["git", "status"],
      commandActions: [],
      exitCode: 0,
    });
    expect(calls[0].evidence[0].rawName).toBe("exec_command");
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
    expect(calls.map((call) => call.canonicalName)).toEqual(["exec_command", "mcp__docs.get"]);
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
      canonicalName: "exec_command",
      cwd: "/repo",
      status: "completed",
      executionEvidence: "runtime-confirmed",
    });
    expect(calls[0].input).toMatchObject({ cmd: "ls -la", command: ["ls", "-la"], exitCode: 0 });
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

  it("lets runtime failure signals override a generic completed status", () => {
    const calls = extractCodexStructuredToolCalls([
      completedRow({
        type: "CommandExecution",
        id: "command-failed",
        command: ["false"],
        status: "completed",
        exit_code: 1,
      }),
      completedRow({
        type: "DynamicToolCall",
        id: "dynamic-failed",
        tool: "read",
        status: "completed",
        success: false,
      }),
      completedRow({
        type: "McpToolCall",
        id: "mcp-failed",
        server: "docs",
        tool: "read",
        status: "completed",
        error: "connection closed",
      }),
    ]);

    expect(calls.map((call) => call.status)).toEqual(["failed", "failed", "failed"]);
  });

  it("treats executed metadata as runtime evidence and merges it with Legacy AST evidence", () => {
    const calls = extractCodexStructuredToolCalls([
      { type: "session_meta", payload: { history_mode: "legacy", cwd: "/repo" } },
      responseRow({
        type: "custom_tool_call",
        name: "exec",
        call_id: "legacy-exec",
        input: "await tools.skills__read({ package: 'e0/search' });",
        internal_chat_message_metadata_passthrough: {
          turn_id: "turn-legacy",
          executed_tool_calls: [{ name: "skills__read", arguments: { package: "e0/search" } }],
        },
      }),
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      parentCallId: "legacy-exec",
      turnId: "turn-legacy",
      canonicalName: "skills.read",
      executionEvidence: "runtime-confirmed",
    });
    expect(calls[1].evidence.map((item) => item.evidence)).toEqual([
      "executed-tool-metadata",
      "code-mode-ast",
    ]);
  });

  it("associates arbitrary paginated completion ids without collapsing repeated executions", () => {
    const calls = extractCodexStructuredToolCalls([
      { type: "session_meta", payload: { history_mode: "paginated", cwd: "/repo" } },
      responseRow({
        type: "custom_tool_call",
        name: "exec",
        call_id: "page-exec",
        input: [
          "await tools.exec_command({ cmd: 'pwd' });",
          "await tools.exec_command({ cmd: 'pwd' });",
        ].join("\n"),
        internal_chat_message_metadata_passthrough: { turn_id: "turn-page" },
      }),
      completedRow({
        type: "CommandExecution",
        id: "runtime-a",
        command: ["zsh", "-lc", "pwd"],
        status: "completed",
        exit_code: 0,
      }, "turn-page"),
      completedRow({
        type: "CommandExecution",
        id: "runtime-b",
        command: ["zsh", "-lc", "pwd"],
        status: "completed",
        exit_code: 0,
      }, "turn-page", "2026-08-01T10:00:06Z"),
    ]);

    const commands = calls.filter((call) => call.canonicalName === "exec_command");
    expect(commands).toHaveLength(2);
    expect(commands.map((call) => call.callId)).toEqual(["runtime-a", "runtime-b"]);
    expect(commands.every((call) => (
      call.parentCallId === "page-exec"
      && call.executionEvidence === "runtime-confirmed"
      && call.evidence.some((item) => item.evidence === "code-mode-ast")
    ))).toBe(true);
  });

  it("keeps safe fields from Promise.all tool arguments that also contain dynamic values", () => {
    const commands = [
      "sed -n '1,260p' pr.md",
      "rg --files .github",
      "git show --stat --oneline HEAD",
      "git log --oneline origin/main..HEAD",
      "sed -n '1,160p' .release-notes/structured-tool-call.md",
    ];
    const source = [
      'const repo = "/repo";',
      "await Promise.all([",
      ...commands.map((cmd) => `  tools.exec_command({ cmd: ${JSON.stringify(cmd)}, workdir: repo }),`),
      "]);",
    ].join("\n");
    const calls = extractCodexStructuredToolCalls([
      responseRow({
        type: "custom_tool_call",
        name: "exec",
        call_id: "promise-exec",
        input: source,
      }),
    ]).filter((call) => call.canonicalName === "exec_command");

    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.input)).toEqual(
      commands.map((cmd) => ({ cmd })),
    );
    expect(calls.every((call) => call.executionEvidence === "static-only")).toBe(true);
  });

  it("does not keep partial AST fields when a dynamic spread can override them", () => {
    const calls = extractCodexStructuredToolCalls([
      responseRow({
        type: "custom_tool_call",
        name: "exec",
        call_id: "spread-exec",
        input: 'await tools.exec_command({ cmd: "unsafe", ...dynamicOptions });',
      }),
    ]);

    expect(calls.find((call) => call.canonicalName === "exec_command")?.input).toBeNull();
  });

  it("does not guess a parent when identical nested calls are ambiguous", () => {
    const calls = extractCodexStructuredToolCalls([
      { type: "session_meta", payload: { history_mode: "paginated" } },
      responseRow({
        type: "custom_tool_call",
        name: "exec",
        call_id: "outer-a",
        input: "await tools.skills__read({ package: 'e0/search' });",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-page" },
      }),
      responseRow({
        type: "custom_tool_call",
        name: "exec",
        call_id: "outer-b",
        input: "await tools.skills__read({ package: 'e0/search' });",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-page" },
      }),
      completedRow({
        type: "DynamicToolCall",
        id: "runtime-read",
        namespace: "skills",
        tool: "read",
        arguments: { package: "e0/search" },
        status: "completed",
        success: true,
      }, "turn-page"),
    ]);

    expect(calls.filter((call) => call.canonicalName === "skills.read")).toHaveLength(3);
    expect(calls.find((call) => call.callId === "runtime-read")?.parentCallId).toBeNull();
  });

  it("sanitizes and bounds persisted collector observations", () => {
    const collector = new CodexToolCallCollector();
    collector.consume({ type: "session_meta", payload: { history_mode: "paginated", cwd: "/repo" } });
    for (let index = 0; index < 40; index += 1) {
      collector.consume(responseRow({
        type: "function_call",
        name: "apply_patch",
        call_id: `large-call-${index}`,
        arguments: JSON.stringify({
          encrypted_payload: `secret-marker-${index}`,
          image_url: `data:image/png;base64,${"A".repeat(20_000)}`,
          patch: `patch-${index}-${"x".repeat(20_000)}`,
        }),
      }));
    }

    const state = collector.state;
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("secret-marker");
    expect(serialized).not.toContain("data:image/png;base64");
    expect(serialized.length).toBeLessThanOrEqual(270_000);
    expect(state.observations.length).toBeLessThan(40);
    expect(state.observations.at(-1)?.callId).toBe("large-call-39");
  });
});
