import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionTraceEvent, TokenUsageEvent } from "../types";
import { loadCodexSessionRows } from "../session-loader";
import { deriveSessionTimeline, TURN_DERIVATION_VERSION } from "./derive-turns";

const messages: SessionMessage[] = [
  {
    role: "user",
    content: "Find the failing test",
    timestamp: "2026-07-23T10:00:00.000Z",
    index: 0,
  },
  {
    role: "assistant",
    content: "I will inspect the test output.",
    timestamp: "2026-07-23T10:00:01.000Z",
    index: 1,
  },
  {
    role: "user",
    content: "Fix it",
    timestamp: "2026-07-23T10:01:00.000Z",
    index: 2,
  },
  {
    role: "assistant",
    content: "The test now passes.",
    timestamp: "2026-07-23T10:01:04.000Z",
    index: 3,
  },
];

const traceEvents: SessionTraceEvent[] = [
  {
    index: 0,
    kind: "tool_call",
    source: "codex",
    title: "shell · npm test",
    detail: "{\"command\":\"npm test\"}",
    timestamp: "2026-07-23T10:00:02.000Z",
    callId: "call-1",
    status: "unknown",
  },
  {
    index: 1,
    kind: "tool_result",
    source: "codex",
    title: "tool output",
    detail: "1 test failed",
    timestamp: "2026-07-23T10:00:05.000Z",
    callId: "call-1",
    status: "failed",
  },
  {
    index: 2,
    kind: "event",
    source: "codex",
    title: "apply_patch",
    detail: "updated the assertion",
    timestamp: "2026-07-23T10:01:02.000Z",
    eventType: "patch_apply_end",
    status: "completed",
  },
];

const tokenEvents: TokenUsageEvent[] = [
  {
    timestamp: Date.parse("2026-07-23T10:00:06.000Z"),
    dedupeKey: "usage-1",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 50,
    reasoningOutputTokens: 5,
    totalTokens: 175,
  },
  {
    timestamp: Date.parse("2026-07-23T10:01:05.000Z"),
    dedupeKey: "usage-2",
    inputTokens: 80,
    outputTokens: 10,
    cachedInputTokens: 20,
    reasoningOutputTokens: 0,
    totalTokens: 110,
  },
];

describe("deriveSessionTimeline", () => {
  it("links Code Mode child tools to their exec parent and does not mark static evidence as running", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:code-mode-group",
      messages: [
        {
          role: "user",
          content: "inspect the skill",
          timestamp: "2026-08-13T09:17:00.000Z",
          index: 0,
        },
      ],
      traceEvents: [
        {
          index: 0,
          kind: "tool_result",
          source: "codex",
          title: "exec · exec_command",
          detail: "done",
          timestamp: "2026-08-13T09:17:00.100Z",
          callId: "call-code-mode",
          status: "completed",
          attributes: {
            tool: {
              canonicalName: "exec",
              executionEvidence: "runtime-confirmed",
            },
          },
        },
        {
          index: 1,
          kind: "tool_call",
          source: "codex",
          title: "exec_command",
          detail: '{"cmd":"sed -n 1,240p SKILL.md"}',
          timestamp: "2026-08-13T09:17:00.100Z",
          callId: "call-code-mode#ast-0",
          status: "unknown",
          attributes: {
            tool: {
              canonicalName: "exec_command",
              executionEvidence: "static-only",
              parentCallId: "call-code-mode",
            },
          },
        },
      ],
    });

    const [parent, child] = timeline.turns[0].spans;
    expect(parent.callId).toBe("call-code-mode");
    expect(child.parentSpanId).toBe(parent.id);
    expect(child.status).toBe("unknown");
  });

  it("projects structured collaboration outputs without a value wrapper", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-list-agents.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-03T02:59:18.000Z",
        payload: { id: "codex-list-agents", cwd: "/repo" },
      },
      {
        type: "response_item",
        timestamp: "2026-08-03T02:59:18.050Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "list agents" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-03T02:59:18.100Z",
        payload: {
          type: "function_call",
          name: "list_agents",
          namespace: "collaboration",
          call_id: "call-list-agents",
          arguments: "{}",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-03T02:59:18.200Z",
        payload: {
          type: "function_call_output",
          call_id: "call-list-agents",
          output: JSON.stringify({
            agents: [
              { agent_name: "/root", agent_status: "running", last_task_message: "Main thread" },
              { agent_name: "/root/list_home_dir", agent_status: "running", last_task_message: null },
            ],
          }),
        },
      },
    ]);

    const timeline = deriveSessionTimeline({
      sessionKey: "codex:codex-list-agents",
      messages: loaded?.messages ?? [],
      traceEvents: loaded?.traceEvents ?? [],
    });

    expect(timeline.turns[0].spans).toMatchObject([{
      name: "collaboration.list_agents",
      output: {
        agents: [
          { agent_name: "/root", agent_status: "running", last_task_message: "Main thread" },
          { agent_name: "/root/list_home_dir", agent_status: "running", last_task_message: null },
        ],
      },
    }]);
  });

  it("does not fill an empty send_message output with the input detail", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-send-message.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-04T03:33:15.000Z",
        payload: { id: "codex-send-message", cwd: "/repo" },
      },
      {
        type: "response_item",
        timestamp: "2026-08-04T03:33:16.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "send the result" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-04T03:33:17.788Z",
        payload: {
          type: "function_call",
          name: "send_message",
          namespace: "collaboration",
          arguments: JSON.stringify({ target: "/root", message: "task result" }),
          call_id: "call-send-message",
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-04T03:33:17.790Z",
        payload: {
          type: "sub_agent_activity",
          event_id: "call-send-message",
          agent_thread_id: "child-thread",
          agent_path: "/root",
          kind: "interacted",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-04T03:33:17.939Z",
        payload: {
          type: "function_call_output",
          call_id: "call-send-message",
          output: "",
        },
      },
    ]);

    const timeline = deriveSessionTimeline({
      sessionKey: "codex:codex-send-message",
      messages: loaded?.messages ?? [],
      traceEvents: loaded?.traceEvents ?? [],
    });
    const sendMessage = timeline.turns[0].spans.find((span) => span.name === "collaboration.send_message");

    expect(sendMessage?.input).toEqual({ target: "/root", message: "task result" });
    expect(sendMessage?.output).toBeNull();
  });

  it("preserves Agent message direction and turn-trigger metadata in collaboration spans", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-agent-message.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-03T03:00:00.000Z",
        payload: { id: "codex-agent-message", cwd: "/repo", agent_path: "/root" },
      },
      {
        type: "response_item",
        timestamp: "2026-08-03T03:00:00.050Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "delegate the task" }],
        },
      },
      {
        type: "inter_agent_communication_metadata",
        timestamp: "2026-08-03T03:00:00.100Z",
        payload: { trigger_turn: false },
      },
      {
        type: "response_item",
        timestamp: "2026-08-03T03:00:00.150Z",
        payload: {
          type: "agent_message",
          author: "/root/worker",
          recipient: "/root",
          content: [{
            type: "input_text",
            text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nDone",
          }],
        },
      },
    ]);

    const timeline = deriveSessionTimeline({
      sessionKey: "codex:codex-agent-message",
      messages: loaded?.messages ?? [],
      traceEvents: loaded?.traceEvents ?? [],
    });

    expect(timeline.turns[0].spans).toMatchObject([{
      name: "Agent message",
      output: {
        message: {
          type: "agent_message",
          author: "/root/worker",
          recipient: "/root",
          content: [{ type: "input_text" }],
        },
        direction: "incoming",
        triggerTurn: false,
        messageType: "final_answer",
      },
      attributes: {
        eventType: "codex.collaboration.message",
        collaboration: {
          author: "/root/worker",
          recipient: "/root",
          direction: "incoming",
          triggerTurn: false,
          messageType: "final_answer",
        },
      },
    }]);
  });

  it("projects plain-text function outputs as text instead of a value wrapper", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:plain-tool-output",
      messages: [{
        role: "user",
        content: "run it",
        timestamp: "2026-08-03T03:00:00.000Z",
        index: 0,
      }],
      traceEvents: [
        {
          index: 0,
          kind: "tool_call",
          source: "codex",
          title: "collaboration.wait_agent",
          detail: "",
          timestamp: "2026-08-03T03:00:00.100Z",
          callId: "call-wait-agent",
          eventType: "codex.function_call",
          status: "running",
          attributes: { input: { timeout_ms: 30_000 } },
        },
        {
          index: 1,
          kind: "tool_result",
          source: "codex",
          title: "tool output",
          detail: "Wait timed out.",
          timestamp: "2026-08-03T03:00:30.100Z",
          callId: "call-wait-agent",
          eventType: "codex.function_call",
          status: "completed",
          attributes: { output: "Wait timed out." },
        },
      ],
    });

    expect(timeline.turns[0].spans).toMatchObject([{
      name: "collaboration.wait_agent",
      output: { text: "Wait timed out." },
    }]);
  });

  it("groups by Codex source turn id and projects lifecycle without creating spans", () => {
    const sourceMessages: SessionMessage[] = [
      {
        role: "user",
        content: "first",
        timestamp: "2026-07-30T08:00:00.000Z",
        index: 0,
        sourceTurnId: "turn-a",
      },
      {
        role: "user",
        content: "second",
        timestamp: "2026-07-30T08:00:00.500Z",
        index: 1,
        sourceTurnId: "turn-b",
      },
      {
        role: "assistant",
        content: "first done",
        timestamp: "2026-07-30T08:00:02.000Z",
        index: 2,
        sourceTurnId: "turn-a",
        phase: "final_answer",
      },
    ];
    const lifecycle: SessionTraceEvent[] = [
      {
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn started",
        detail: "",
        timestamp: "2026-07-30T08:00:00.000Z",
        eventType: "codex.turn.started",
        status: "running",
        sourceTurnId: "turn-a",
        attributes: { startedAt: "2026-07-30T08:00:00.000Z" },
      },
      {
        index: 1,
        kind: "event",
        source: "codex",
        title: "Turn completed",
        detail: "",
        timestamp: "2026-07-30T08:00:03.000Z",
        eventType: "codex.turn.completed",
        status: "completed",
        sourceTurnId: "turn-a",
        attributes: {
          endedAt: "2026-07-30T08:00:03.000Z",
          durationMs: 3_000,
          timeToFirstTokenMs: 125,
        },
      },
      {
        index: 2,
        kind: "event",
        source: "codex",
        title: "Turn aborted",
        detail: "replaced",
        timestamp: "2026-07-30T08:00:01.000Z",
        eventType: "codex.turn.aborted",
        status: "aborted",
        sourceTurnId: "turn-b",
        attributes: { abortReason: "replaced", durationMs: 500 },
      },
    ];

    const timeline = deriveSessionTimeline({
      sessionKey: "codex:source-turns",
      messages: sourceMessages,
      traceEvents: lifecycle,
      codexIncrementalState: {
        historyMode: "paginated",
        messageProvenance: [
          { messageIndex: 0, sourceRecordId: "response_item:user-a" },
          { messageIndex: 1, sourceRecordId: "response_item:user-b" },
          { messageIndex: 2, sourceRecordId: "response_item:answer-a" },
        ],
        activeTurnIds: [],
      },
    });

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[0]).toMatchObject({
      sourceMessageIndex: 0,
      sourceTurnId: "turn-a",
      status: "completed",
      durationMs: 3_000,
      timeToFirstTokenMs: 125,
      spans: [],
    });
    expect(timeline.turns[0].messages[1].metadata).toEqual({
      sourceTurnId: "turn-a",
      phase: "final_answer",
      codex: { sourceItemId: "response_item:answer-a" },
    });
    expect(timeline.turns[1]).toMatchObject({
      sourceMessageIndex: 1,
      sourceTurnId: "turn-b",
      status: "aborted",
      durationMs: 500,
      abortReason: "replaced",
      spans: [],
    });
    expect(timeline.turns[0].id).toBe(
      deriveSessionTimeline({
        sessionKey: "codex:source-turns",
        messages: sourceMessages.map((message) => ({ ...message, sourceTurnId: null })),
      }).turns[0].id,
    );
  });

  it("reattaches assistant replies tagged with a completed Codex turn to the newer user turn", () => {
    const sourceMessages: SessionMessage[] = [
      {
        role: "user",
        content: "先定路线",
        timestamp: "2026-08-04T06:00:00.000Z",
        index: 0,
        sourceTurnId: "turn-old",
      },
      {
        role: "assistant",
        content: "先确认第一点？",
        timestamp: "2026-08-04T06:00:30.000Z",
        index: 1,
        sourceTurnId: "turn-old",
        phase: "final_answer",
      },
      {
        role: "user",
        content: "可以",
        timestamp: "2026-08-04T06:14:00.000Z",
        index: 2,
        sourceTurnId: "turn-new",
      },
      {
        role: "assistant",
        content: "第一部分建议采用控制面拆分。",
        timestamp: "2026-08-04T06:14:20.000Z",
        index: 3,
        sourceTurnId: "turn-old",
        phase: "final_answer",
      },
      {
        role: "user",
        content: "认可",
        timestamp: "2026-08-04T06:15:00.000Z",
        index: 4,
        sourceTurnId: "turn-newer",
      },
      {
        role: "assistant",
        content: "第二部分建议逐级优化导入。",
        timestamp: "2026-08-04T06:15:20.000Z",
        index: 5,
        sourceTurnId: "turn-old",
        phase: "final_answer",
      },
    ];
    const lifecycle: SessionTraceEvent[] = [
      {
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn completed",
        detail: "",
        timestamp: "2026-08-04T06:01:00.000Z",
        eventType: "codex.turn.completed",
        status: "completed",
        sourceTurnId: "turn-old",
        attributes: { endedAt: "2026-08-04T06:01:00.000Z" },
      },
      {
        index: 1,
        kind: "event",
        source: "codex",
        title: "Turn completed",
        detail: "",
        timestamp: "2026-08-04T06:14:40.000Z",
        eventType: "codex.turn.completed",
        status: "completed",
        sourceTurnId: "turn-new",
        attributes: { endedAt: "2026-08-04T06:14:40.000Z" },
      },
      {
        index: 2,
        kind: "event",
        source: "codex",
        title: "Turn completed",
        detail: "",
        timestamp: "2026-08-04T06:15:40.000Z",
        eventType: "codex.turn.completed",
        status: "completed",
        sourceTurnId: "turn-newer",
        attributes: { endedAt: "2026-08-04T06:15:40.000Z" },
      },
    ];

    const timeline = deriveSessionTimeline({
      sessionKey: "codex:stale-turn-id",
      messages: sourceMessages,
      traceEvents: lifecycle,
    });

    expect(timeline.turns).toHaveLength(3);
    expect(timeline.turns[0]).toMatchObject({
      sourceTurnId: "turn-old",
      userText: "先定路线",
      assistantText: "先确认第一点？",
    });
    expect(timeline.turns[1]).toMatchObject({
      sourceTurnId: "turn-new",
      userText: "可以",
      assistantText: "第一部分建议采用控制面拆分。",
    });
    expect(timeline.turns[2]).toMatchObject({
      sourceTurnId: "turn-newer",
      userText: "认可",
      assistantText: "第二部分建议逐级优化导入。",
    });
    expect(timeline.turns[1].messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(timeline.turns[2].messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("keeps a final reply on its lifecycle Turn when completed_at loses milliseconds", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-subagent-completion-precision.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-12T09:05:46.144Z",
        payload: {
          id: "child",
          cwd: "/repo",
          agent_path: "/root/researcher",
          thread_source: "subagent",
          parent_thread_id: "parent",
          history_mode: "legacy",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-12T09:05:46.145Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inherited parent request" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-parent" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-12T09:14:40.627Z",
        payload: {
          type: "task_started",
          turn_id: "turn-subagent-interrupted",
          started_at: Date.parse("2026-08-12T09:14:40.000Z") / 1_000,
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-12T09:18:49.523Z",
        payload: {
          type: "turn_aborted",
          turn_id: "turn-subagent-interrupted",
          completed_at: Date.parse("2026-08-12T09:18:49.000Z") / 1_000,
          reason: "interrupted",
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-12T09:18:59.853Z",
        payload: {
          type: "task_started",
          turn_id: "turn-subagent-final",
          started_at: Date.parse("2026-08-12T09:18:59.000Z") / 1_000,
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-12T09:19:24.198Z",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Research report completed" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-subagent-final" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-12T09:19:24.205Z",
        payload: {
          type: "task_complete",
          turn_id: "turn-subagent-final",
          completed_at: Date.parse("2026-08-12T09:19:24.000Z") / 1_000,
          duration_ms: 24_352,
        },
      },
    ]);
    if (!loaded) throw new Error("expected a loaded subagent session");

    const timeline = deriveSessionTimeline({
      sessionKey: loaded.session.sessionKey,
      messages: loaded.messages,
      traceEvents: loaded.traceEvents ?? [],
      tokenEvents: loaded.tokenEvents,
      codexIncrementalState: loaded.codexIncrementalState,
    });

    expect(timeline.turns).toHaveLength(3);
    expect(timeline.turns).toMatchObject([
      {
        sourceTurnId: "turn-parent",
        userText: "Inherited parent request",
        assistantText: "",
      },
      {
        sourceTurnId: "turn-subagent-interrupted",
        status: "aborted",
        assistantText: "",
      },
      {
        sourceTurnId: "turn-subagent-final",
        status: "completed",
        assistantText: "Research report completed",
      },
    ]);
  });

  it("keeps a started Codex Turn running until a lifecycle terminal arrives", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:active-turn",
      messages: [{
        role: "user",
        content: "keep working",
        timestamp: "2026-07-30T08:00:00.000Z",
        index: 0,
        sourceTurnId: "turn-active",
      }],
      traceEvents: [{
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn started",
        detail: "",
        timestamp: "2026-07-30T08:00:00.000Z",
        eventType: "codex.turn.started",
        status: "running",
        sourceTurnId: "turn-active",
      }],
      codexIncrementalState: {
        historyMode: "paginated",
        messageProvenance: [{ messageIndex: 0, sourceRecordId: "response_item:user-active" }],
        activeTurnIds: ["turn-active"],
      },
    });

    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0].status).toBe("running");
  });

  it("retains rolled-back token usage without creating a token-only Turn", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-token-only-rollback.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-07-30T09:00:00Z",
        payload: { id: "codex-token-only-rollback", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:01Z",
        payload: { type: "task_started", turn_id: "turn-rolled" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:02Z",
        payload: {
          type: "message",
          id: "user-rolled",
          role: "user",
          content: [{ type: "input_text", text: "撤销这轮" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-rolled" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:03Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:04Z",
        payload: { type: "turn_aborted", turn_id: "turn-rolled", reason: "interrupted" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:05Z",
        payload: { type: "thread_rolled_back", num_turns: 1 },
      },
    ]);
    if (!loaded) throw new Error("Expected the rolled-back Codex fixture to load.");

    const timeline = deriveSessionTimeline({
      sessionKey: loaded.session.sessionKey,
      messages: loaded.messages,
      traceEvents: loaded.traceEvents,
      tokenEvents: loaded.tokenEvents,
      codexIncrementalState: loaded.codexIncrementalState,
    });

    expect(loaded.tokenEvents).toHaveLength(1);
    expect(loaded.session.tokenUsage?.totalTokens).toBe(11);
    expect(timeline.turns).toEqual([]);
  });

  it("does not attribute a rolled-back Turn's token usage to the preceding retained Turn", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-rollback-token-attribution.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-07-30T09:00:00Z",
        payload: { id: "codex-rollback-token-attribution", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:01Z",
        payload: { type: "task_started", turn_id: "turn-kept" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:02Z",
        payload: {
          type: "message",
          id: "user-kept",
          role: "user",
          content: [{ type: "input_text", text: "保留这轮" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-kept" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:03Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:04Z",
        payload: { type: "task_complete", turn_id: "turn-kept" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:01:00Z",
        payload: { type: "task_started", turn_id: "turn-rolled" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:01:01Z",
        payload: {
          type: "message",
          id: "user-rolled",
          role: "user",
          content: [{ type: "input_text", text: "撤销这轮" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-rolled" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:01:02Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 20, output_tokens: 2 } },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:01:03Z",
        payload: { type: "turn_aborted", turn_id: "turn-rolled", reason: "interrupted" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:01:04Z",
        payload: { type: "thread_rolled_back", num_turns: 1 },
      },
    ]);
    if (!loaded) throw new Error("Expected the rollback token attribution fixture to load.");

    const timeline = deriveSessionTimeline({
      sessionKey: loaded.session.sessionKey,
      messages: loaded.messages,
      traceEvents: loaded.traceEvents,
      tokenEvents: loaded.tokenEvents,
      codexIncrementalState: loaded.codexIncrementalState,
    });

    expect(loaded.session.tokenUsage?.totalTokens).toBe(33);
    expect(loaded.tokenEvents?.map((event) => event.sourceTurnId)).toEqual(["turn-kept", "turn-rolled"]);
    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0]).toMatchObject({
      sourceTurnId: "turn-kept",
      totalTokens: 11,
    });
  });

  it("derives legacy Codex token usage only for the retained lifecycle Turn", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-legacy-token-attribution.jsonl", [
      {
        type: "session_meta",
        timestamp: "2025-08-01T09:00:00Z",
        payload: { id: "codex-legacy-token-attribution", cwd: "/repo", history_mode: "legacy" },
      },
      {
        type: "event_msg",
        timestamp: "2025-08-01T09:00:01Z",
        payload: { type: "task_started", model_context_window: 200_000 },
      },
      {
        type: "response_item",
        timestamp: "2025-08-01T09:00:02Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "保留这轮" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2025-08-01T09:00:03Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } },
        },
      },
      {
        type: "event_msg",
        timestamp: "2025-08-01T09:00:04Z",
        payload: { type: "task_complete", last_agent_message: null },
      },
      {
        type: "event_msg",
        timestamp: "2025-08-01T09:01:00Z",
        payload: { type: "task_started", model_context_window: 200_000 },
      },
      {
        type: "response_item",
        timestamp: "2025-08-01T09:01:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "撤销这轮" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2025-08-01T09:01:02Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 20, output_tokens: 2 } },
        },
      },
      {
        type: "event_msg",
        timestamp: "2025-08-01T09:01:03Z",
        payload: { type: "turn_aborted", reason: "interrupted" },
      },
      {
        type: "event_msg",
        timestamp: "2025-08-01T09:01:04Z",
        payload: { type: "thread_rolled_back", num_turns: 1 },
      },
    ]);
    if (!loaded) throw new Error("Expected the legacy Codex fixture to load.");

    const timeline = deriveSessionTimeline({
      sessionKey: loaded.session.sessionKey,
      messages: loaded.messages,
      traceEvents: loaded.traceEvents,
      tokenEvents: loaded.tokenEvents,
      codexIncrementalState: loaded.codexIncrementalState,
    });

    expect(loaded.session.tokenUsage?.totalTokens).toBe(33);
    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0]).toMatchObject({
      sourceTurnId: "agent-recall:legacy-turn:1",
      status: "completed",
      totalTokens: 11,
      synthetic: false,
    });
  });

  it("creates one searchable Turn per user request and pairs tool calls with their results", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:test",
      messages,
      traceEvents,
      tokenEvents,
    });

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[0]).toMatchObject({
      turnIndex: 0,
      sourceMessageIndex: 0,
      synthetic: false,
      status: "failed",
      userText: "Find the failing test",
      assistantText: "I will inspect the test output.",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 50,
      reasoningOutputTokens: 5,
      totalTokens: 175,
      errorCount: 1,
      toolNames: ["shell"],
      derivationVersion: TURN_DERIVATION_VERSION,
    });
    expect(timeline.turns[0].searchText).toBe(
      "Find the failing test\n\nI will inspect the test output.",
    );
    expect(timeline.turns[0].toolText).toContain("1 test failed");
    expect(timeline.turns[0].messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(timeline.turns[0].spans).toHaveLength(1);
    expect(timeline.turns[0].spans[0]).toMatchObject({
      kind: "tool",
      name: "shell",
      status: "failed",
      callId: "call-1",
      input: { text: "{\"command\":\"npm test\"}" },
      output: { text: "1 test failed" },
    });

    expect(timeline.turns[1]).toMatchObject({
      turnIndex: 1,
      sourceMessageIndex: 2,
      status: "completed",
      userText: "Fix it",
      assistantText: "The test now passes.",
      totalTokens: 110,
      toolNames: ["apply_patch"],
    });
  });

  it("keeps complete compact detail in the Turn span output", () => {
    const compactDetail = `payload:\nretained-start-${"x".repeat(12_000)}-retained-end`;
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:compact-detail",
      messages: [{
        role: "user",
        content: "Continue after compact",
        timestamp: "2026-08-10T04:44:00.000Z",
        index: 0,
        sourceTurnId: "turn-compact",
      }],
      traceEvents: [{
        index: 0,
        kind: "event",
        source: "codex",
        title: "Context compacted",
        detail: compactDetail,
        timestamp: "2026-08-10T04:44:12.000Z",
        eventType: "codex.context.compaction",
        status: "completed",
        sourceTurnId: "turn-compact",
        attributes: {
          compaction: {
            itemCount: 27,
            itemTypes: { message: 26, compaction: 1 },
            opaqueCompaction: true,
          },
        },
      }],
    });

    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0].spans[0]).toMatchObject({
      kind: "event",
      name: "Context compacted",
      output: { text: compactDetail },
      attributes: {
        compaction: {
          itemCount: 27,
          itemTypes: { message: 26, compaction: 1 },
          opaqueCompaction: true,
        },
      },
    });
    expect(timeline.rawEvents[1].payload).toMatchObject({ detail: compactDetail });
  });

  it("keeps preamble events in a synthetic Turn instead of attributing them to the first request", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:preamble",
      messages: [messages[0]],
      traceEvents: [{
        ...traceEvents[2],
        index: 0,
        timestamp: "2026-07-23T09:59:00.000Z",
      }],
    });

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[0]).toMatchObject({
      turnIndex: 0,
      sourceMessageIndex: null,
      synthetic: true,
      toolNames: ["apply_patch"],
    });
    expect(timeline.turns[1]).toMatchObject({
      turnIndex: 1,
      sourceMessageIndex: 0,
      synthetic: false,
      userText: "Find the failing test",
    });
  });

  it("treats lifecycle-backed subagent work as real Turns instead of repeated preambles", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-subagent-turns.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-12T09:05:00.000Z",
        payload: {
          id: "child",
          cwd: "/repo",
          agent_path: "/root/researcher",
          thread_source: "subagent",
          parent_thread_id: "parent",
          history_mode: "paginated",
        },
      },
      {
        type: "inter_agent_communication_metadata",
        timestamp: "2026-08-12T09:05:00.050Z",
        payload: { trigger_turn: true },
      },
      {
        type: "response_item",
        timestamp: "2026-08-12T09:05:00.100Z",
        payload: {
          type: "agent_message",
          author: "/root",
          recipient: "/root/researcher",
          content: [{
            type: "input_text",
            text: "Message Type: NEW_TASK\nTask name: /root/researcher\nSender: /root\nPayload:\nResearch the issue",
          }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-12T09:05:00.200Z",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        type: "response_item",
        timestamp: "2026-08-12T09:05:01.000Z",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "I will inspect the primary sources." }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-12T09:13:47.000Z",
        payload: { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" },
      },
      {
        type: "inter_agent_communication_metadata",
        timestamp: "2026-08-12T09:14:00.050Z",
        payload: { trigger_turn: true },
      },
      {
        type: "response_item",
        timestamp: "2026-08-12T09:14:00.100Z",
        payload: {
          type: "agent_message",
          author: "/root",
          recipient: "/root/researcher",
          content: [{
            type: "input_text",
            text: "Message Type: MESSAGE\nTask name: /root/researcher\nSender: /root\nPayload:\nContinue",
          }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-2" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-12T09:14:00.200Z",
        payload: { type: "task_started", turn_id: "turn-2" },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-12T09:18:09.000Z",
        payload: { type: "turn_aborted", turn_id: "turn-2", reason: "interrupted" },
      },
    ]);
    if (!loaded) throw new Error("expected a loaded subagent session");

    const timeline = deriveSessionTimeline({
      sessionKey: loaded.session.sessionKey,
      messages: loaded.messages,
      traceEvents: loaded.traceEvents ?? [],
      tokenEvents: loaded.tokenEvents,
      codexIncrementalState: loaded.codexIncrementalState,
    });

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns).toMatchObject([
      {
        sourceTurnId: "turn-1",
        synthetic: false,
        status: "aborted",
        assistantText: "I will inspect the primary sources.",
      },
      {
        sourceTurnId: "turn-2",
        synthetic: false,
        status: "aborted",
        assistantText: "",
      },
    ]);
  });

  it("assigns id-less collaboration activity to the latest lifecycle-backed subagent Turn", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:forked-subagent",
      messages: [{
        role: "user",
        content: "Parent request inherited at fork time",
        timestamp: "2026-08-12T09:05:18.000Z",
        index: 0,
        sourceTurnId: "parent-turn",
      }],
      traceEvents: [
        {
          index: 0,
          kind: "event",
          source: "codex",
          title: "Parent Turn started",
          detail: "",
          timestamp: "2026-08-12T09:05:18.000Z",
          eventType: "codex.turn.started",
          status: "running",
          sourceTurnId: "parent-turn",
          attributes: { startedAt: "2026-08-12T09:05:18.000Z" },
        },
        {
          index: 1,
          kind: "event",
          source: "codex",
          title: "Subagent Turn started",
          detail: "",
          timestamp: "2026-08-12T09:05:46.000Z",
          eventType: "codex.turn.started",
          status: "running",
          sourceTurnId: "subagent-turn",
          attributes: { startedAt: "2026-08-12T09:05:46.000Z" },
        },
        {
          index: 2,
          kind: "event",
          source: "codex",
          title: "subagent · started",
          detail: "",
          timestamp: "2026-08-12T09:06:04.000Z",
          eventType: "codex.collaboration.activity",
          status: "completed",
          attributes: {
            codex: { rawType: "sub_agent_activity" },
            collaboration: { kind: "started", agentThreadId: "grandchild" },
          },
        },
      ],
    });

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[0]).toMatchObject({
      sourceTurnId: "parent-turn",
      spans: [],
    });
    expect(timeline.turns[1]).toMatchObject({
      sourceTurnId: "subagent-turn",
      synthetic: false,
      spans: [{ name: "subagent" }],
    });
  });

  it("creates a synthetic Turn when a transcript has no user message", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "claude:assistant-only",
      messages: [{
        role: "assistant",
        content: "Background task finished",
        timestamp: "",
        index: 4,
      }],
      traceEvents: [],
    });

    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0]).toMatchObject({
      turnIndex: 0,
      sourceMessageIndex: null,
      synthetic: true,
      assistantText: "Background task finished",
    });
  });

  it("projects a completed paginated tool item into one span with structured input and output", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:completed-tool",
      messages: [{
        role: "user",
        content: "list files",
        timestamp: "2026-07-30T08:00:00.000Z",
        index: 0,
        sourceTurnId: "turn-1",
      }],
      traceEvents: [{
        index: 0,
        kind: "tool_result",
        source: "codex",
        title: "shell · ls",
        detail: "input and output preview",
        timestamp: "2026-07-30T08:00:02.000Z",
        callId: "command-1",
        eventType: "codex.command_execution",
        status: "completed",
        sourceTurnId: "turn-1",
        attributes: {
          startedAt: "2026-07-30T08:00:01.000Z",
          endedAt: "2026-07-30T08:00:02.000Z",
          input: { command: "ls" },
          output: { stdout: "file.txt", exitCode: 0 },
        },
      }],
    });

    expect(timeline.turns[0].spans).toMatchObject([{
      callId: "command-1",
      status: "completed",
      startedAt: "2026-07-30T08:00:01.000Z",
      endedAt: "2026-07-30T08:00:02.000Z",
      input: { command: "ls" },
      output: { stdout: "file.txt", exitCode: 0 },
    }]);
  });

  it("projects an aggregated Codex call through intermediate events with its call title and duration", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-intermediate-tool-span.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-07-30T10:50:23Z",
        payload: { id: "codex-intermediate-tool-span", cwd: "/repo" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T10:50:23.500Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "search the docs" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T10:50:24Z",
        payload: {
          type: "function_call",
          name: "run",
          namespace: "web",
          call_id: "web-call-1",
          arguments: JSON.stringify({
            search_query: [{ q: "custom tool call input format" }],
          }),
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T10:50:26Z",
        payload: {
          type: "web_search_end",
          call_id: "web-call-1",
          query: "custom tool call input format",
          action: { type: "search" },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T10:50:31Z",
        payload: {
          type: "function_call_output",
          call_id: "web-call-1",
          output: { results: [{ title: "Custom tools" }] },
        },
      },
    ]);

    const timeline = deriveSessionTimeline({
      sessionKey: "codex:intermediate-tool-span",
      messages: loaded?.messages ?? [],
      traceEvents: loaded?.traceEvents ?? [],
    });

    expect(timeline.turns[0].spans).toMatchObject([{
      name: "web.run",
      callId: "web-call-1",
      status: "completed",
      startedAt: "2026-07-30T10:50:24.000Z",
      endedAt: "2026-07-30T10:50:31.000Z",
      input: {
        search_query: [{ q: "custom tool call input format" }],
        query: "custom tool call input format",
        action: { type: "search" },
      },
      output: { results: [{ title: "Custom tools" }] },
    }]);
  });

  it("keeps rich Codex traces visible without counting them as tool names", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:rich-traces",
      messages: [{
        role: "user",
        content: "review this",
        timestamp: "2026-07-30T08:00:00.000Z",
        index: 0,
        sourceTurnId: "turn-1",
      }],
      traceEvents: [
        {
          index: 0,
          kind: "event",
          source: "codex",
          title: "Reasoning summary",
          detail: "Checked the parser boundary",
          timestamp: "2026-07-30T08:00:01.000Z",
          eventType: "codex.reasoning_summary",
          status: "completed",
          sourceTurnId: "turn-1",
        },
        {
          index: 1,
          kind: "event",
          source: "codex",
          title: "Plan",
          detail: "Run focused tests",
          timestamp: "2026-07-30T08:00:02.000Z",
          eventType: "codex.plan",
          status: "completed",
          sourceTurnId: "turn-1",
        },
      ],
    });

    expect(timeline.turns[0].spans).toHaveLength(2);
    expect(timeline.turns[0].errorCount).toBe(0);
    expect(timeline.turns[0].toolNames).toEqual([]);
  });

  it("generates stable identifiers independent of input array order", () => {
    const sameTimeTokenEvents = tokenEvents.map((event) => ({
      ...event,
      timestamp: tokenEvents[0].timestamp,
    }));
    const first = deriveSessionTimeline({
      sessionKey: "codex:stable",
      messages,
      traceEvents,
      tokenEvents: sameTimeTokenEvents,
    });
    const reordered = deriveSessionTimeline({
      sessionKey: "codex:stable",
      messages: [...messages].reverse(),
      traceEvents: [...traceEvents].reverse(),
      tokenEvents: [...sameTimeTokenEvents].reverse(),
    });

    expect(reordered).toEqual(first);
  });

  it("preserves every source item as an ordered raw event", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:raw",
      messages,
      traceEvents,
      tokenEvents,
    });

    expect(timeline.rawEvents).toHaveLength(messages.length + traceEvents.length + tokenEvents.length);
    expect(timeline.rawEvents.map((event) => event.eventIndex)).toEqual(
      timeline.rawEvents.map((_, index) => index),
    );
    expect(new Set(timeline.rawEvents.map((event) => event.eventId)).size).toBe(timeline.rawEvents.length);
    expect(timeline.rawEvents.map((event) => event.kind)).toEqual([
      "message",
      "message",
      "trace",
      "trace",
      "token",
      "message",
      "trace",
      "message",
      "token",
    ]);
  });

  it("assigns large trace histories without rescanning every Turn", () => {
    const startedAt = Date.parse("2026-07-23T10:00:00.000Z");
    const manyMessages = Array.from({ length: 800 }, (_, index): SessionMessage => ({
      role: "user",
      content: `request ${index}`,
      timestamp: new Date(startedAt + index * 1_000).toISOString(),
      index,
    }));
    const manyTraceEvents = Array.from({ length: 8_000 }, (_, index): SessionTraceEvent => ({
      index,
      kind: "event",
      source: "codex",
      title: "progress",
      detail: "",
      timestamp: new Date(startedAt + (index % manyMessages.length) * 1_000 + 1).toISOString(),
      status: "completed",
    }));

    const before = performance.now();
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:large",
      messages: manyMessages,
      traceEvents: manyTraceEvents,
    });

    expect(timeline.turns).toHaveLength(manyMessages.length);
    expect(timeline.rawEvents).toHaveLength(manyMessages.length + manyTraceEvents.length);
    expect(performance.now() - before).toBeLessThan(1_500);
  });
});
