import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadClaudeCliSessionRows,
  loadClaudeCliSessions,
  loadCodeBuddyCliSessionFile,
  loadCodeBuddyCliSessionRows,
  loadCodeBuddyCliSessions,
  loadWorkBuddyCliSessions,
  loadCodexSessionFile,
  loadCodexSessionRows,
  loadCodexSessionsIterator,
  loadCodexSessions,
  loadDefaultSessions,
  loadWorkBuddyCliSessionFile,
  parseCodexSessionMetaLine,
} from "./session-loader";
import { TRACE_DETAIL_PREVIEW_MAX_CHARS } from "./trace-detail";

describe("Codex session loading", () => {
  it("uses the first real turn_context cwd when Desktop metadata has a local-workspace placeholder", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-placeholder-workspace.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-18T00:00:00Z",
        payload: { session_id: "codex-placeholder", cwd: "<local-workspace>", originator: "Codex Desktop" },
      },
      {
        type: "turn_context",
        timestamp: "2026-08-18T00:00:01Z",
        payload: { cwd: "E:\\Code\\CreatedProject", workspace_roots: ["E:\\Code\\CreatedProject"] },
      },
      {
        type: "response_item",
        timestamp: "2026-08-18T00:00:02Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "创建项目后的第一条消息" }] },
      },
    ]);

    expect(loaded?.session.projectPath).toBe("E:\\Code\\CreatedProject");
  });

  it("preserves explicit timezone offsets as absolute instants", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-offset.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-09T00:46:00+08:00",
        payload: { id: "codex-offset", cwd: "/repo" },
      },
      {
        type: "response_item",
        timestamp: "2026-08-09T00:47:00+08:00",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "check timezone" }],
        },
      },
    ]);

    expect(loaded?.session.timestamp).toBe(Date.parse("2026-08-08T16:46:00.000Z"));
    expect(new Date(loaded?.messages[0].timestamp ?? "").toISOString()).toBe("2026-08-08T16:47:00.000Z");
  });

  it("shows a readable sanitized copy of the original compacted payload", () => {
    const longReadableText = `retained-start-${"x".repeat(TRACE_DETAIL_PREVIEW_MAX_CHARS)}-retained-end`;
    const nestedImageDataUrl = `data:image/png;base64,${"A".repeat(1_100)}`;
    const nestedImageBareBase64 = "E".repeat(1_100);
    const arrayBase64 = "B".repeat(1_100);
    const unknownFieldBase64 = "C".repeat(1_100);
    const base64Url = `${"D".repeat(1_100)}-_`;
    const loaded = loadCodexSessionRows("/tmp/codex-compacted.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-04T08:00:00.000Z",
        payload: { id: "codex-compacted", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-04T08:00:01.000Z",
        payload: { type: "task_started", turn_id: "turn-compact" },
      },
      {
        type: "compacted",
        timestamp: "2026-08-04T08:00:02.000Z",
        payload: {
          message: "Readable handoff summary",
          replacement_history: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: `Readable retained user request\n${longReadableText}` },
                { type: "input_image", image_url: "data:image/png;base64,must-not-index-image", detail: "high" },
                {
                  type: "input_image",
                  image_url: { url: nestedImageDataUrl },
                  data: [arrayBase64],
                  file_data: unknownFieldBase64,
                },
                { type: "input_image", image_url: { url: nestedImageBareBase64 } },
                { type: "input_file", data: base64Url },
              ],
              internal_chat_message_metadata_passthrough: { turn_id: "retained-turn" },
            },
            {
              type: "function_call",
              name: "read_file",
              arguments: "{\"path\":\"README.md\"}",
              call_id: "call-retained",
            },
            {
              type: "compaction",
              id: "encrypted-compaction",
              encrypted_content: "must-not-index-encrypted-summary",
            },
          ],
          window_number: 2,
          first_window_id: "window-first",
          previous_window_id: "window-previous",
          window_id: "window-current",
        },
      },
      {
        type: "world_state",
        timestamp: "2026-08-04T08:00:02.100Z",
        payload: { full: true, state: { private: "must-not-index-world-state" } },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-04T08:00:03.000Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-compact",
          completed_at_ms: Date.parse("2026-08-04T08:00:03.000Z"),
          item: { type: "ContextCompaction", id: "compact-item" },
        },
      },
    ]);

    const compactions = loaded?.traceEvents?.filter(
      (event) => event.eventType === "codex.context.compaction",
    ) ?? [];
    expect(compactions).toHaveLength(1);
    expect(compactions[0].detail).toContain("payload:");
    expect(compactions[0].detail).toContain("Readable handoff summary");
    expect(compactions[0].detail).toContain('"replacement_history"');
    expect(compactions[0].detail).toContain('"role": "user"');
    expect(compactions[0].detail).toContain("Readable retained user request");
    expect(compactions[0].detail).toContain(longReadableText);
    expect(compactions[0].detail.length).toBeGreaterThan(TRACE_DETAIL_PREVIEW_MAX_CHARS);
    expect(compactions[0].detail).not.toContain("Indexed preview truncated");
    expect(compactions[0].detail).toContain('"type": "function_call"');
    expect(compactions[0].detail).toContain('"name": "read_file"');
    expect(compactions[0].detail).toContain('"window_number": 2');
    expect(compactions[0].detail).toContain('"first_window_id": "window-first"');
    expect(compactions[0].detail).toContain('"previous_window_id": "window-previous"');
    expect(compactions[0].detail).toContain('"window_id": "window-current"');
    expect(compactions[0].detail).toContain('"image_url": "[binary omitted:');
    expect(compactions[0].detail).toContain('"url": "[binary omitted: 1100 characters]"');
    expect(compactions[0].detail).toContain('"encrypted_content": "[encrypted content omitted]"');
    expect(compactions[0].detail).not.toContain(nestedImageDataUrl);
    expect(compactions[0].detail).not.toContain(nestedImageBareBase64);
    expect(compactions[0].detail).not.toContain(arrayBase64);
    expect(compactions[0].detail).not.toContain(unknownFieldBase64);
    expect(compactions[0].detail).not.toContain(base64Url);
    expect(compactions[0].attributes?.compaction).toEqual({
      itemCount: 3,
      itemTypes: { message: 1, function_call: 1, compaction: 1 },
      opaqueCompaction: true,
    });
    const serializedTrace = JSON.stringify(loaded?.traceEvents);
    expect(serializedTrace).not.toContain("must-not-index-encrypted-summary");
    expect(serializedTrace).not.toContain("must-not-index-image");
    expect(serializedTrace).not.toContain(nestedImageDataUrl);
    expect(serializedTrace).not.toContain(nestedImageBareBase64);
    expect(serializedTrace).not.toContain(arrayBase64);
    expect(serializedTrace).not.toContain(unknownFieldBase64);
    expect(serializedTrace).not.toContain(base64Url);
    expect(serializedTrace).not.toContain("must-not-index-world-state");
  });

  it("caps oversized compacted details after sanitization", () => {
    const readable = `oversized-start ${"readable compact content ".repeat(30_000)} oversized-end`;
    const loaded = loadCodexSessionRows("/tmp/codex-oversized-compacted.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-04T08:00:00.000Z",
        payload: { id: "codex-oversized-compacted", cwd: "/repo" },
      },
      {
        type: "compacted",
        timestamp: "2026-08-04T08:00:01.000Z",
        payload: { replacement_history: [{ type: "message", content: readable }] },
      },
    ]);

    const detail = loaded?.traceEvents?.find(
      (event) => event.eventType === "codex.context.compaction",
    )?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(512 * 1_024);
    expect(detail).toContain("oversized-start");
    expect(detail).toContain("[Indexed preview truncated:");
    expect(detail).not.toContain("oversized-end");
  });

  it("preserves long encoded-looking text outside binary fields", () => {
    const readableSlug = "feature-branch-name-".repeat(80);
    const nestedReadableSlug = "nested-feature-branch-name-".repeat(70);
    const loaded = loadCodexSessionRows("/tmp/codex-readable-compact-string.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-04T08:00:00.000Z",
        payload: { id: "codex-readable-compact-string", cwd: "/repo" },
      },
      {
        type: "compacted",
        timestamp: "2026-08-04T08:00:01.000Z",
        payload: {
          replacement_history: [{
            type: "message",
            diagnostic_label: readableSlug,
            data: { diagnostic_label: nestedReadableSlug },
            file_data: "A".repeat(1_100),
            unknown_binary: "B".repeat(64 * 1_024),
          }],
        },
      },
    ]);

    const detail = loaded?.traceEvents?.find(
      (event) => event.eventType === "codex.context.compaction",
    )?.detail ?? "";
    expect(detail).toContain(readableSlug);
    expect(detail).toContain(nestedReadableSlug);
    expect(detail).toContain('"file_data": "[binary omitted: 1100 characters]"');
    expect(detail).toContain('"unknown_binary": "[binary omitted: 65536 characters]"');
  });

  it("deduplicates matching compact markers without depending on record order or exact turn attribution", () => {
    const meta = {
      type: "session_meta",
      timestamp: "2026-08-04T08:00:00.000Z",
      payload: { id: "codex-compact-dedupe", cwd: "/repo" },
    };
    const started = {
      type: "event_msg",
      timestamp: "2026-08-04T08:00:00.100Z",
      payload: { type: "task_started", turn_id: "turn-compact" },
    };
    const checkpoint = (timestamp: string) => ({
      type: "compacted",
      timestamp,
      payload: { replacement_history: [] },
    });
    const responseMarker = (type: "compaction" | "context_compaction", timestamp: string) => ({
      type: "response_item",
      timestamp,
      payload: {
        type,
        internal_chat_message_metadata_passthrough: { turn_id: "turn-compact" },
      },
    });
    const eventMarker = (timestamp: string) => ({
      type: "event_msg",
      timestamp,
      payload: { type: "context_compacted", turn_id: "turn-compact" },
    });
    const compactions = (rows: unknown[]) => loadCodexSessionRows(
      "/tmp/codex-compact-dedupe.jsonl",
      rows,
    )?.traceEvents?.filter((event) => event.eventType === "codex.context.compaction") ?? [];

    expect(compactions([meta, started, checkpoint("2026-08-04T08:00:01.000Z"), responseMarker("compaction", "2026-08-04T08:00:01.050Z")])).toHaveLength(1);
    expect(compactions([meta, started, checkpoint("2026-08-04T08:00:01.000Z"), responseMarker("context_compaction", "2026-08-04T08:00:01.050Z")])).toHaveLength(1);
    expect(compactions([meta, started, eventMarker("2026-08-04T08:00:01.000Z"), checkpoint("2026-08-04T08:00:01.050Z")])).toHaveLength(1);
    expect(compactions([meta, checkpoint("2026-08-04T08:00:01.000Z"), started, eventMarker("2026-08-04T08:00:01.050Z")])).toHaveLength(1);
    expect(compactions([meta, started, checkpoint("2026-08-04T08:00:01.000Z"), eventMarker("2026-08-04T08:00:03.000Z")])).toHaveLength(1);
    expect(compactions([
      meta,
      started,
      checkpoint("2026-08-04T08:00:01.000Z"),
      eventMarker("2026-08-04T08:00:01.700Z"),
      checkpoint("2026-08-04T08:00:01.900Z"),
      eventMarker("2026-08-04T08:00:02.800Z"),
    ])).toHaveLength(2);
    expect(compactions([
      meta,
      started,
      checkpoint("2026-08-04T08:00:01.000Z"),
      {
        type: "event_msg",
        timestamp: "2026-08-04T08:00:01.025Z",
        payload: { type: "task_started", turn_id: "turn-other" },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-04T08:00:01.050Z",
        payload: { type: "context_compacted", turn_id: "turn-other" },
      },
    ])).toHaveLength(2);
    expect(compactions([
      meta,
      started,
      checkpoint("2026-08-04T08:00:01.000Z"),
      eventMarker("2026-08-04T09:00:01.000Z"),
    ])).toHaveLength(2);
    expect(compactions([
      meta,
      started,
      eventMarker("2026-08-04T08:00:01.000Z"),
      checkpoint("2026-08-04T08:10:01.000Z"),
    ])).toHaveLength(2);
    expect(compactions([
      meta,
      started,
      checkpoint("2026-08-04T08:00:01.000Z"),
      eventMarker("not-a-timestamp"),
    ])).toHaveLength(1);
    expect(compactions([
      meta,
      started,
      checkpoint("not-a-timestamp"),
      eventMarker("2026-08-04T08:00:01.000Z"),
    ])).toHaveLength(1);
  });

  it("preserves encrypted metadata primitives and recognizes normalized compaction types", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-encrypted-metadata.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-04T08:00:00.000Z",
        payload: { id: "codex-encrypted-metadata", cwd: "/repo" },
      },
      {
        type: "compacted",
        timestamp: "2026-08-04T08:00:01.000Z",
        payload: {
          replacement_history: [{
            type: "ContextCompaction",
            encrypted_content: "must-not-index-encrypted-content",
            is_encrypted: false,
            encrypted_bytes: 512,
          }],
        },
      },
    ]);

    const compaction = loaded?.traceEvents?.find(
      (event) => event.eventType === "codex.context.compaction",
    );
    expect(compaction?.detail).toContain('"encrypted_content": "[encrypted content omitted]"');
    expect(compaction?.detail).toContain('"is_encrypted": false');
    expect(compaction?.detail).toContain('"encrypted_bytes": 512');
    expect(compaction?.detail).not.toContain("must-not-index-encrypted-content");
    expect(compaction?.attributes?.compaction).toMatchObject({ opaqueCompaction: true });
  });

  it("decodes structured collaboration function outputs", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-list-agents.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-03T02:59:18.000Z",
        payload: { id: "codex-list-agents", cwd: "/repo" },
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

    expect(loaded?.traceEvents).toHaveLength(1);
    expect(loaded?.traceEvents?.[0].attributes?.output).toEqual({
      agents: [
        { agent_name: "/root", agent_status: "running", last_task_message: "Main thread" },
        { agent_name: "/root/list_home_dir", agent_status: "running", last_task_message: null },
      ],
    });
  });

  it("keeps an empty send_message function output distinct from its input", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-send-message.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-04T03:33:15.000Z",
        payload: { id: "codex-send-message", cwd: "/repo" },
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

    const sendMessage = loaded?.traceEvents?.find((event) => event.callId === "call-send-message");
    expect(sendMessage?.attributes?.input).toEqual({ target: "/root", message: "task result" });
    expect(sendMessage?.attributes?.output).toBe("");
    expect(sendMessage?.attributes?.output).not.toEqual(sendMessage?.attributes?.input);
  });

  it("preserves Codex message phases and normalizes turn lifecycle metadata", () => {
    const rows = [
      {
        type: "session_meta",
        timestamp: "2026-07-30T08:00:00Z",
        payload: { id: "codex-lifecycle", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:01Z",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
          started_at: 1_775_059_201,
          trace_id: "trace-1",
          model_context_window: 200_000,
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:02Z",
        payload: {
          type: "message",
          id: "message-1",
          role: "assistant",
          phase: "commentary",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          content: [{ type: "output_text", text: "正在检查" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:03Z",
        payload: {
          type: "message",
          id: "message-2",
          role: "assistant",
          phase: "final_answer",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          content: [{ type: "output_text", text: "检查完成" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:04.205Z",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
          started_at: 1_775_059_201,
          completed_at: 1_775_059_204,
          duration_ms: 3_000,
          time_to_first_token_ms: 250,
          last_agent_message: "检查完成",
        },
      },
    ];

    const loaded = loadCodexSessionRows("/tmp/codex-lifecycle.jsonl", rows);

    expect(loaded?.messages).toMatchObject([
      { content: "正在检查", sourceTurnId: "turn-1", phase: "commentary" },
      { content: "检查完成", sourceTurnId: "turn-1", phase: "final_answer" },
    ]);
    expect(loaded?.traceEvents).toMatchObject([
      {
        eventType: "codex.turn.started",
        status: "running",
        sourceTurnId: "turn-1",
        attributes: { traceId: "trace-1", modelContextWindow: 200_000 },
      },
      {
        eventType: "codex.turn.completed",
        timestamp: "2026-07-30T08:00:04.205Z",
        status: "completed",
        sourceTurnId: "turn-1",
        attributes: { durationMs: 3_000, timeToFirstTokenMs: 250 },
      },
    ]);
    expect(loaded?.codexIncrementalState).toEqual({
      historyMode: "paginated",
      messageProvenance: [
        { messageIndex: 0, sourceRecordId: "response_item:message-1" },
        { messageIndex: 1, sourceRecordId: "response_item:message-2" },
      ],
      activeTurnIds: [],
    });
  });

  it("only assigns an id-less abort to a uniquely active Codex turn", () => {
    const meta = { type: "session_meta", payload: { id: "codex-abort", cwd: "/repo" } };
    const started = (turnId: string) => ({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } });

    const unique = loadCodexSessionRows("/tmp/codex-abort.jsonl", [
      meta,
      started("turn-1"),
      { type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted", duration_ms: 10 } },
    ]);
    const ambiguous = loadCodexSessionRows("/tmp/codex-abort-ambiguous.jsonl", [
      meta,
      started("turn-1"),
      started("turn-2"),
      { type: "event_msg", payload: { type: "turn_aborted", reason: "replaced" } },
    ]);

    expect(unique?.traceEvents?.at(-1)).toMatchObject({
      eventType: "codex.turn.aborted",
      status: "aborted",
      sourceTurnId: "turn-1",
      attributes: { abortReason: "interrupted", durationMs: 10 },
    });
    expect(ambiguous?.traceEvents?.at(-1)?.sourceTurnId).toBeNull();
    expect(ambiguous?.codexIncrementalState?.activeTurnIds).toEqual(["turn-1", "turn-2"]);
  });

  it("detects current and legacy subagent metadata without treating ordinary forks as subagents", () => {
    expect(
      parseCodexSessionMetaLine({
        type: "session_meta",
        payload: {
          id: "child-current",
          source: { subagent: { thread_spawn: { parent_thread_id: "parent-current", depth: 1 } } },
        },
      }),
    ).toMatchObject({ isSubagent: true, parentSessionId: "parent-current" });
    expect(
      parseCodexSessionMetaLine({
        type: "session_meta",
        payload: { id: "child-legacy", thread_source: "subagent", parent_thread_id: "parent-legacy" },
      }),
    ).toMatchObject({ isSubagent: true, parentSessionId: "parent-legacy" });
    expect(
      parseCodexSessionMetaLine({
        type: "session_meta",
        payload: { id: "ordinary-fork", forked_from_id: "some-session", originator: "codex-tui", session_id: "ordinary-fork" },
      }),
    ).toMatchObject({ isSubagent: false, parentSessionId: null });
  });

  it("keeps Codex Agent message metadata and encrypted content together in structured output", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-agent-messages.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-04T03:00:00Z",
        payload: { id: "child", cwd: "/repo", agent_path: "/root/worker", thread_source: "subagent", parent_thread_id: "parent" },
      },
      { type: "inter_agent_communication_metadata", timestamp: "2026-08-04T03:00:01Z", payload: { trigger_turn: true } },
      {
        type: "response_item",
        timestamp: "2026-08-04T03:00:01Z",
        payload: {
          type: "agent_message",
          id: "new-task",
          author: "/root",
          recipient: "/root/worker",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n" },
            { type: "encrypted_content", encrypted_content: "must-not-index-encrypted-task" },
          ],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      { type: "inter_agent_communication_metadata", timestamp: "2026-08-04T03:00:02Z", payload: { trigger_turn: false } },
      {
        type: "response_item",
        timestamp: "2026-08-04T03:00:02Z",
        payload: {
          type: "agent_message",
          id: "outgoing-message",
          author: "/root/worker",
          recipient: "/root",
          content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\n检查完成" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
    ]);

    const messages = loaded?.traceEvents?.filter((event) => event.eventType === "codex.collaboration.message") ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      title: "Agent message",
      sourceTurnId: "turn-1",
      attributes: {
        collaboration: {
          author: "/root",
          recipient: "/root/worker",
          direction: "incoming",
          triggerTurn: true,
          messageType: "new_task",
        },
      },
    });
    expect(messages[1]).toMatchObject({
      attributes: {
        collaboration: {
          direction: "outgoing",
          triggerTurn: false,
          messageType: "final_answer",
        },
      },
    });
    expect(JSON.parse(messages[0]?.detail ?? "")).toMatchObject({
      direction: "incoming",
      triggerTurn: true,
      messageType: "new_task",
      message: {
        type: "agent_message",
        author: "/root",
        recipient: "/root/worker",
        content: [
          { type: "input_text" },
          { type: "encrypted_content", encrypted_content: "must-not-index-encrypted-task" },
        ],
      },
    });
    expect(JSON.parse(messages[1]?.detail ?? "")).toMatchObject({
      direction: "outgoing",
      triggerTurn: false,
      messageType: "final_answer",
    });
  });

  it("keeps pending inter-agent metadata across incremental Codex reads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-agent-message-"));
    const filePath = path.join(root, "sessions", "2026", "08", "04", "rollout.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-04T03:00:00Z", payload: { id: "parent", cwd: "/repo" } }),
      JSON.stringify({ type: "inter_agent_communication_metadata", timestamp: "2026-08-04T03:00:01Z", payload: { trigger_turn: false } }),
      "",
    ].join("\n"));

    try {
      const initial = loadCodexSessionFile(filePath);
      if (!initial) throw new Error("expected initial Codex session");
      const offset = fs.statSync(filePath).size;
      fs.appendFileSync(filePath, `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-04T03:00:02Z",
        payload: {
          type: "agent_message",
          id: "child-result",
          author: "/root/worker",
          recipient: "/root",
          content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nDone" }],
        },
      })}\n`);

      const incremental = [...loadCodexSessionsIterator(root, undefined, {
        incrementalCodexSessions: new Map([[filePath, { offset, loaded: initial }]]),
      })][0];
      expect(incremental?.traceEvents?.find((event) => event.eventType === "codex.collaboration.message")).toMatchObject({
        attributes: { collaboration: { direction: "incoming", triggerTurn: false, messageType: "final_answer" } },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades a paginated Code Mode trace across incremental reads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-tool-state-"));
    const filePath = path.join(root, "sessions", "2026", "08", "20", "rollout.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-20T03:00:00Z",
        payload: { id: "tool-state", cwd: "/repo", history_mode: "paginated" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-20T03:00:01Z",
        payload: { type: "task_started", turn_id: "turn-tool" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-20T03:00:02Z",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "code-mode-incremental",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-tool" },
          input: "await tools.exec_command({ cmd: 'pwd' });",
        },
      }),
      "",
    ].join("\n"));

    try {
      const initial = loadCodexSessionFile(filePath);
      if (!initial) throw new Error("expected initial Codex session");
      const offset = fs.statSync(filePath).size;
      fs.appendFileSync(filePath, `${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-20T03:00:03Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-tool",
          item: {
            type: "CommandExecution",
            id: "exec-runtime-incremental",
            command: ["/bin/zsh", "-lc", "pwd"],
            cwd: "/repo",
            status: "completed",
            exit_code: 0,
            duration: { secs: 1, nanos: 250_000_000 },
          },
        },
      })}\n`);

      const incremental = [...loadCodexSessionsIterator(root, undefined, {
        incrementalCodexSessions: new Map([[filePath, { offset, loaded: initial }]]),
      })][0];
      const nestedCommands = incremental?.traceEvents?.filter((event) => {
        const tool = event.attributes?.tool as Record<string, unknown> | undefined;
        return tool?.parentCallId === "code-mode-incremental" && tool.canonicalName === "exec_command";
      }) ?? [];
      expect(nestedCommands).toHaveLength(1);
      expect(nestedCommands[0]).toMatchObject({
        callId: "exec-runtime-incremental",
        status: "completed",
        attributes: {
          durationMs: 1_250,
          tool: { executionEvidence: "runtime-confirmed" },
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps unknown Agent message direction across incremental reads for subagents without agent_path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-null-agent-path-"));
    const filePath = path.join(root, "sessions", "2026", "08", "04", "rollout.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const agentMessage = {
      type: "response_item",
      timestamp: "2026-08-04T03:00:01Z",
      payload: {
        type: "agent_message",
        id: "from-root",
        author: "/root",
        recipient: "/root/worker",
        content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nGo" }],
      },
    };
    fs.writeFileSync(filePath, [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-04T03:00:00Z",
        payload: { id: "child", cwd: "/repo", thread_source: "subagent", parent_thread_id: "parent" },
      }),
      JSON.stringify(agentMessage),
      "",
    ].join("\n"));

    try {
      const initial = loadCodexSessionFile(filePath);
      if (!initial) throw new Error("expected initial Codex session");
      expect(initial.session.isSubagent).toBe(true);
      expect(initial.codexIncrementalState?.agentPath).toBeNull();
      expect(initial.traceEvents?.find((event) => event.eventType === "codex.collaboration.message")).toMatchObject({
        attributes: { collaboration: { direction: "unknown", author: "/root", recipient: "/root/worker" } },
      });

      const offset = fs.statSync(filePath).size;
      fs.appendFileSync(filePath, `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-04T03:00:02Z",
        payload: {
          type: "agent_message",
          id: "to-root",
          author: "/root/worker",
          recipient: "/root",
          content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nDone" }],
        },
      })}\n`);

      const incremental = [...loadCodexSessionsIterator(root, undefined, {
        incrementalCodexSessions: new Map([[filePath, { offset, loaded: initial }]]),
      })][0];
      const messages = incremental?.traceEvents?.filter((event) => event.eventType === "codex.collaboration.message") ?? [];
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        attributes: { collaboration: { direction: "unknown", author: "/root", recipient: "/root/worker" } },
      });
      expect(messages[1]).toMatchObject({
        attributes: { collaboration: { direction: "unknown", author: "/root/worker", recipient: "/root" } },
      });
      expect(incremental?.codexIncrementalState?.agentPath).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps resolved Agent message direction across incremental reads when subagent has agent_path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-agent-path-"));
    const filePath = path.join(root, "sessions", "2026", "08", "04", "rollout.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-04T03:00:00Z",
        payload: {
          id: "child",
          cwd: "/repo",
          agent_path: "/root/worker",
          thread_source: "subagent",
          parent_thread_id: "parent",
        },
      }),
      "",
    ].join("\n"));

    try {
      const initial = loadCodexSessionFile(filePath);
      if (!initial) throw new Error("expected initial Codex session");
      expect(initial.codexIncrementalState?.agentPath).toBe("/root/worker");

      const offset = fs.statSync(filePath).size;
      fs.appendFileSync(filePath, `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-04T03:00:01Z",
        payload: {
          type: "agent_message",
          id: "from-root",
          author: "/root",
          recipient: "/root/worker",
          content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nGo" }],
        },
      })}\n`);

      const incremental = [...loadCodexSessionsIterator(root, undefined, {
        incrementalCodexSessions: new Map([[filePath, { offset, loaded: initial }]]),
      })][0];
      expect(incremental?.traceEvents?.find((event) => event.eventType === "codex.collaboration.message")).toMatchObject({
        attributes: { collaboration: { direction: "incoming", author: "/root", recipient: "/root/worker" } },
      });
      expect(incremental?.codexIncrementalState?.agentPath).toBe("/root/worker");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips unchanged source files before parsing JSONL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-skip-"));
    const filePath = path.join(root, "sessions", "2026", "06", "26", "rollout.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not valid jsonl");
    const skipped: string[] = [];

    const loaded = [
      ...loadCodexSessionsIterator(root, undefined, {
        shouldSkipFile: () => true,
        onSkippedFile: (skippedPath) => skipped.push(skippedPath),
      }),
    ];

    expect(loaded).toEqual([]);
    expect(skipped).toEqual([filePath]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("extracts id, cwd, originator, first question, and visible messages from a rollout file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-1", cwd: "/repo", originator: "Codex Desktop", git: { branch: "feat/session-tags" } },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md\nnoise" }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:02:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "修复登录态失效" }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:03:00Z",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "我来检查 auth 逻辑" }] },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.session).toMatchObject({
      sessionKey: "codex:codex-1",
      rawId: "codex-1",
      source: "codex-app",
      projectPath: "/repo",
      firstQuestion: "修复登录态失效",
      originalTitle: "修复登录态失效",
      gitBranch: "feat/session-tags",
    });
    expect(loaded?.messages.map((m) => m.content)).toEqual(["修复登录态失效", "我来检查 auth 逻辑"]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("shows only the effective Codex turns after multiple rollbacks while retaining all token usage", () => {
    const message = (role: "user" | "assistant", text: string) => ({
      type: "response_item",
      timestamp: "2026-07-28T10:00:00Z",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    });
    const token = (timestamp: string, inputTokens: number) => ({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: inputTokens, output_tokens: 1 } },
      },
    });
    const rows = [
      { type: "session_meta", timestamp: "2026-07-28T09:00:00Z", payload: { id: "codex-rollback", cwd: "/repo" } },
      message("user", "保留第一问"),
      message("assistant", "第一答"),
      token("2026-07-28T10:01:00Z", 10),
      message("user", "撤销的问题"),
      message("assistant", "撤销的回答"),
      token("2026-07-28T10:02:00Z", 20),
      { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
      message("user", "替代问题"),
      message("assistant", "替代回答"),
      token("2026-07-28T10:03:00Z", 30),
      { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
      message("user", "最终问题"),
      message("assistant", "最终回答"),
    ];

    const loaded = loadCodexSessionRows("/tmp/codex-rollback.jsonl", rows);

    expect(loaded?.messages.map((entry) => entry.content)).toEqual(["保留第一问", "第一答", "最终问题", "最终回答"]);
    expect(loaded?.session.tokenUsage?.inputTokens).toBe(60);
  });

  it("removes the complete Codex lifecycle for a rolled-back turn", () => {
    const retainedRows = [
      { type: "session_meta", timestamp: "2026-07-30T09:00:00Z", payload: { id: "codex-lifecycle-rollback", cwd: "/repo" } },
      { type: "event_msg", timestamp: "2026-07-30T09:00:01Z", payload: { type: "task_started", turn_id: "turn-kept" } },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:02Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "保留的问题" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-kept" },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:03Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "保留的回答" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-kept" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:03.500Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } },
        },
      },
      { type: "event_msg", timestamp: "2026-07-30T09:00:04Z", payload: { type: "task_complete", turn_id: "turn-kept" } },
    ];
    const rolledBackRows = [
      { type: "event_msg", timestamp: "2026-07-30T09:00:05Z", payload: { type: "task_started", turn_id: "turn-rolled" } },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:06Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "撤销的问题" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-rolled" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:07Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 20, output_tokens: 2 } },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:07.500Z",
        payload: { type: "turn_aborted", turn_id: "turn-rolled", reason: "interrupted" },
      },
      { type: "event_msg", timestamp: "2026-07-30T09:00:08Z", payload: { type: "thread_rolled_back", num_turns: 1 } },
      { type: "event_msg", timestamp: "2026-07-30T09:00:09Z", payload: { type: "task_started", turn_id: "turn-active-rolled" } },
      { type: "event_msg", timestamp: "2026-07-30T09:00:10Z", payload: { type: "thread_rolled_back", num_turns: 1 } },
    ];
    const rows = [...retainedRows, ...rolledBackRows];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-lifecycle-rollback-"));
    const filePath = path.join(tempDir, "sessions", "2026", "07", "30", "rollout.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${retainedRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    try {
      const initialLoaded = loadCodexSessionFile(filePath);
      if (!initialLoaded) throw new Error("expected the initial Codex fixture to load");
      const initialOffset = fs.statSync(filePath).size;
      fs.appendFileSync(filePath, `${rolledBackRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
      const incrementalLoaded = [...loadCodexSessionsIterator(tempDir, undefined, {
        incrementalCodexSessions: new Map([[filePath, { offset: initialOffset, loaded: initialLoaded }]]),
      })][0];

      for (const loaded of [
        loadCodexSessionRows(filePath, rows),
        loadCodexSessionFile(filePath),
        incrementalLoaded,
      ]) {
        const traceEvents = loaded?.traceEvents ?? [];
        expect(loaded?.messages.map((message) => message.content)).toEqual(["保留的问题", "保留的回答"]);
        expect(traceEvents.some((event) =>
          event.sourceTurnId === "turn-rolled" || event.sourceTurnId === "turn-active-rolled"
        )).toBe(false);
        expect(traceEvents.filter((event) => event.sourceTurnId === "turn-kept")).toMatchObject([
          { eventType: "codex.turn.started", status: "running" },
          { eventType: "codex.turn.completed", status: "completed" },
        ]);
        expect(loaded?.tokenEvents?.map((event) => event.sourceTurnId)).toEqual(["turn-kept", "turn-rolled"]);
        expect(loaded?.session.tokenUsage?.totalTokens).toBe(33);
        expect(loaded?.codexIncrementalState?.activeTurnIds).toEqual([]);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("assigns internal Turn ownership to legacy Codex rollouts", () => {
    const retainedRows = [
      { type: "session_meta", timestamp: "2026-07-30T09:00:00Z", payload: { id: "codex-legacy-turns", cwd: "/repo" } },
      { type: "event_msg", timestamp: "2026-07-30T09:00:01Z", payload: { type: "task_started" } },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:02Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "保留的问题" }] },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:03Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "保留的回答" }] },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:03.500Z",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } },
      },
      { type: "event_msg", timestamp: "2026-07-30T09:00:04Z", payload: { type: "task_complete" } },
    ];
    const rolledBackRows = [
      { type: "event_msg", timestamp: "2026-07-30T09:00:05Z", payload: { type: "task_started" } },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:06Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "回滚的问题" }] },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:07Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "回滚的回答" }] },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:07.500Z",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 20, output_tokens: 2 } } },
      },
      { type: "event_msg", timestamp: "2026-07-30T09:00:08Z", payload: { type: "task_complete" } },
      { type: "event_msg", timestamp: "2026-07-30T09:00:09Z", payload: { type: "thread_rolled_back", num_turns: 1 } },
    ];
    const replacementRows = [
      { type: "event_msg", timestamp: "2026-07-30T09:00:10Z", payload: { type: "task_started" } },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:11Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "新的问题" }] },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:12Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "新的回答" }] },
      },
      { type: "event_msg", timestamp: "2026-07-30T09:00:13Z", payload: { type: "task_complete" } },
    ];
    const rows = [...retainedRows, ...rolledBackRows, ...replacementRows];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-legacy-turns-"));
    const filePath = path.join(tempDir, "sessions", "2026", "07", "30", "rollout.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${retainedRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    try {
      const initialLoaded = loadCodexSessionFile(filePath);
      if (!initialLoaded) throw new Error("expected the initial Codex fixture to load");
      const initialOffset = fs.statSync(filePath).size;
      fs.appendFileSync(filePath, `${rolledBackRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
      const rolledBackLoaded = [...loadCodexSessionsIterator(tempDir, undefined, {
        incrementalCodexSessions: new Map([[filePath, { offset: initialOffset, loaded: initialLoaded }]]),
      })][0];
      if (!rolledBackLoaded) throw new Error("expected the rolled-back Codex fixture to load");
      const rolledBackOffset = fs.statSync(filePath).size;
      fs.appendFileSync(filePath, `${replacementRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
      const incrementalLoaded = [...loadCodexSessionsIterator(tempDir, undefined, {
        incrementalCodexSessions: new Map([[filePath, { offset: rolledBackOffset, loaded: rolledBackLoaded }]]),
      })][0];

      for (const loaded of [
        loadCodexSessionRows(filePath, rows),
        loadCodexSessionFile(filePath),
        incrementalLoaded,
      ]) {
        const keptTurnId = loaded?.messages.find((message) => message.content === "保留的问题")?.sourceTurnId;
        const replacementTurnId = loaded?.messages.find((message) => message.content === "新的问题")?.sourceTurnId;
        const traceEvents = loaded?.traceEvents ?? [];
        expect(keptTurnId).toBe("agent-recall:legacy-turn:1");
        expect(replacementTurnId).toBe("agent-recall:legacy-turn:3");
        expect(traceEvents.filter((event) => event.sourceTurnId === keptTurnId)).toMatchObject([
          { eventType: "codex.turn.started" },
          { eventType: "codex.turn.completed" },
        ]);
        expect(traceEvents.filter((event) => event.sourceTurnId === "agent-recall:legacy-turn:2")).toEqual([]);
        expect(loaded?.tokenEvents?.map((event) => event.sourceTurnId)).toEqual([
          "agent-recall:legacy-turn:1",
          "agent-recall:legacy-turn:2",
        ]);
        expect(loaded?.session.tokenUsage?.totalTokens).toBe(33);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to the complete Codex message sequence for an invalid rollback marker", () => {
    const rows = [
      { type: "session_meta", payload: { id: "codex-invalid-rollback", cwd: "/repo" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "旧问题" }] } },
      { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: "one" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "新问题" }] } },
    ];

    expect(loadCodexSessionRows("/tmp/codex-invalid-rollback.jsonl", rows)?.messages.map((entry) => entry.content)).toEqual([
      "旧问题",
      "新问题",
    ]);
  });

  it("recognizes the current Codex desktop originator", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-app-originator-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-19T14:37:55Z",
          payload: {
            id: "codex-current-desktop",
            cwd: "/Users/test/Documents/Codex/2026-07-19/rewrite-feishu-doc",
            originator: "codex_work_desktop",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-19T14:38:17Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "重写飞书文档" }] },
        }),
      ].join("\n"),
    );

    expect(loadCodexSessionFile(filePath)?.session.source).toBe("codex-app");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extracts Codex token usage from token_count events without double counting duplicates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-token-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:01:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              last_token_usage: {
                input_tokens: 1200,
                cached_input_tokens: 200,
                output_tokens: 350,
                reasoning_output_tokens: 50,
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:02:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              last_token_usage: {
                input_tokens: 1200,
                cached_input_tokens: 200,
                output_tokens: 350,
                reasoning_output_tokens: 50,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.session.tokenUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 300,
      cachedInputTokens: 200,
      reasoningOutputTokens: 50,
      totalTokens: 1550,
    });
    expect(loaded?.tokenEvents).toEqual([
      {
        dedupeKey: "codex:gpt-5-codex:1000:300:200:50:0:0",
        timestamp: new Date("2026-06-01T10:01:00Z").getTime(),
        inputTokens: 1000,
        outputTokens: 300,
        cachedInputTokens: 200,
        reasoningOutputTokens: 50,
        totalTokens: 1550,
      },
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses the cumulative total_token_usage rather than summing per-turn last usage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-total-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:01:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              last_token_usage: { input_tokens: 1000, output_tokens: 200 },
              total_token_usage: { input_tokens: 1000, output_tokens: 200 },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:02:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              // last reflects only the final request of the turn (1200 input),
              // but the cumulative total grew to 4000 input because intermediate
              // tool-call requests were not emitted as their own last usage.
              last_token_usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 100, reasoning_output_tokens: 10 },
              total_token_usage: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 600, reasoning_output_tokens: 60 },
            },
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    // Authoritative cumulative total: input 4000 - cached 1000 = 3000 fresh,
    // output 600 - reasoning 60 = 540, cached 1000, reasoning 60.
    // (Summing per-turn last usage would wrongly yield input 1200, output 290.)
    expect(loaded?.session.tokenUsage).toEqual({
      inputTokens: 3000,
      outputTokens: 540,
      cachedInputTokens: 1000,
      reasoningOutputTokens: 60,
      totalTokens: 4600,
    });
    expect(loaded?.tokenEvents).toEqual([
      {
        dedupeKey: "codex-total:gpt-5-codex:1780308060000:1000:200:0:0",
        timestamp: new Date("2026-06-01T10:01:00Z").getTime(),
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 1200,
      },
      {
        dedupeKey: "codex-total:gpt-5-codex:1780308120000:3000:540:1000:60",
        timestamp: new Date("2026-06-01T10:02:00Z").getTime(),
        inputTokens: 2000,
        outputTokens: 340,
        cachedInputTokens: 1000,
        reasoningOutputTokens: 60,
        totalTokens: 3400,
      },
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("splits Codex cumulative token totals into dated deltas for period stats", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-04T10:00:00Z",
          payload: { id: "codex-long-running", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-04T10:01:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              total_token_usage: {
                input_tokens: 10_000,
                cached_input_tokens: 8_000,
                output_tokens: 500,
                reasoning_output_tokens: 100,
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-16T06:23:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              total_token_usage: {
                input_tokens: 12_500,
                cached_input_tokens: 9_500,
                output_tokens: 700,
                reasoning_output_tokens: 150,
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-16T06:24:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5.4",
              total_token_usage: {
                input_tokens: 12_500,
                cached_input_tokens: 9_500,
                output_tokens: 700,
                reasoning_output_tokens: 150,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.session.tokenUsage).toEqual({
      inputTokens: 3000,
      outputTokens: 550,
      cachedInputTokens: 9500,
      reasoningOutputTokens: 150,
      totalTokens: 13200,
    });
    expect(loaded?.tokenEvents).toEqual([
      {
        dedupeKey: "codex-total:gpt-5-codex:1780567260000:2000:400:8000:100",
        timestamp: new Date("2026-06-04T10:01:00Z").getTime(),
        inputTokens: 2000,
        outputTokens: 400,
        cachedInputTokens: 8000,
        reasoningOutputTokens: 100,
        totalTokens: 10500,
      },
      {
        dedupeKey: "codex-total:gpt-5-codex:1781590980000:3000:550:9500:150",
        timestamp: new Date("2026-06-16T06:23:00Z").getTime(),
        inputTokens: 1000,
        outputTokens: 150,
        cachedInputTokens: 1500,
        reasoningOutputTokens: 50,
        totalTokens: 2700,
      },
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles interleaved Codex cumulative token sequences in one session file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-interleaved-total", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:01:00Z",
          payload: {
            type: "token_count",
            info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 50_000_000, output_tokens: 1_000 } },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:02:00Z",
          payload: {
            type: "token_count",
            info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 13_000_000, output_tokens: 500 } },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:03:00Z",
          payload: {
            type: "token_count",
            info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 50_100_000, output_tokens: 1_200 } },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:04:00Z",
          payload: {
            type: "token_count",
            info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 13_100_000, output_tokens: 700 } },
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.session.tokenUsage).toEqual({
      inputTokens: 63_200_000,
      outputTokens: 1_900,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 63_201_900,
    });
    expect(loaded?.tokenEvents?.map((event) => event.totalTokens)).toEqual([50_001_000, 13_000_500, 100_200, 100_200]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extracts Codex tool calls and execution events as trace events", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-trace-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "列一下文件" }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:02:00Z",
          payload: {
            type: "function_call",
            name: "shell_command",
            call_id: "call-1",
            arguments: JSON.stringify({ command: "ls -la", workdir: "/repo" }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:03:00Z",
          payload: { type: "function_call_output", call_id: "call-1", output: "total 8" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:04:00Z",
          payload: {
            type: "exec_command_end",
            call_id: "call-1",
            command: "ls -la",
            cwd: "/repo",
            exit_code: 0,
            stdout: "total 8",
            stderr: "",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:05:00Z",
          payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1 } } },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.traceEvents).toHaveLength(1);
    expect(loaded?.traceEvents?.[0]).toMatchObject({
      kind: "tool_result",
      source: "codex",
      title: "shell_command · ls -la",
      callId: "call-1",
      eventType: "codex.function_call",
      status: "completed",
    });
    expect(loaded?.traceEvents?.[0].detail).toContain("total 8");
    expect(loaded?.traceEvents?.[0].attributes).toMatchObject({
      startedAt: "2026-06-01T10:02:00Z",
      endedAt: "2026-06-01T10:04:00Z",
      input: {
        command: "ls -la",
        workdir: "/repo",
        cwd: "/repo",
      },
      output: {
        stdout: "total 8",
        exitCode: 0,
        responseValue: "total 8",
      },
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses the explicit Codex execution terminal without dropping response output", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-failed-execution.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-07-30T08:00:00Z",
        payload: { id: "codex-failed-execution", cwd: "/repo" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "failed-call-1",
          arguments: JSON.stringify({ command: "cat missing.txt" }),
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "failed-call-1",
          output: "command returned an error",
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:03Z",
        payload: {
          type: "exec_command_end",
          call_id: "failed-call-1",
          command: "cat missing.txt",
          cwd: "/repo",
          exit_code: 1,
          stdout: "",
          stderr: "No such file",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:04Z",
        payload: {
          type: "function_call_output",
          call_id: "failed-call-1",
          output: "final wrapper output",
        },
      },
    ]);

    expect(loaded?.traceEvents).toHaveLength(1);
    expect(loaded?.traceEvents?.[0]).toMatchObject({
      kind: "tool_result",
      title: "shell_command · cat missing.txt",
      timestamp: "2026-07-30T08:00:03Z",
      status: "failed",
      attributes: {
        startedAt: "2026-07-30T08:00:01Z",
        endedAt: "2026-07-30T08:00:04Z",
        output: {
          stderr: "No such file",
          exitCode: 1,
          responseValue: "final wrapper output",
        },
      },
    });
  });

  it("extracts nested tools from Codex exec calls without rewriting freeform input", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    const input = [
      'const decoy = "tools.fake({})";',
      "// tools.ignored({});",
      "object.tools.alsoIgnored({});",
      'const first = await tools.exec_command({ cmd: "pwd" });',
      "const results = await Promise.all([",
      '  tools.web__run({ search_query: [{ q: "Codex tools" }] }),',
      '  tools["mcp__memory__search"]({ query: "session" }),',
      '  tools.exec_command({ cmd: "git status" }),',
      "]);",
    ].join("\n");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-custom-trace-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "custom-1",
            input,
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:02:00Z",
          payload: {
            type: "custom_tool_call_output",
            call_id: "custom-1",
            output: "query completed",
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.traceEvents).toHaveLength(5);
    expect(loaded?.traceEvents?.[0]).toMatchObject({
      index: 0,
      kind: "tool_result",
      source: "codex",
      title: "exec · exec_command, web.run, mcp.memory.search",
      timestamp: "2026-06-01T10:02:00Z",
      callId: "custom-1",
      eventType: "codex.custom_tool",
      status: "completed",
      attributes: {
        input,
        nestedTools: ["exec_command", "web__run", "mcp__memory__search"],
        output: "query completed",
      },
    });
    expect(loaded?.traceEvents?.[0].detail).toContain(input);
    expect(loaded?.traceEvents?.[0].detail).toContain("query completed");
    expect(loaded?.traceEvents?.slice(1).map((event) => ({
      callId: event.callId,
      name: (event.attributes?.tool as Record<string, unknown> | undefined)?.canonicalName,
      evidence: (event.attributes?.tool as Record<string, unknown> | undefined)?.executionEvidence,
    }))).toEqual([
      { callId: "custom-1#ast-0", name: "exec_command", evidence: "static-only" },
      { callId: "custom-1#ast-1", name: "web.run", evidence: "static-only" },
      { callId: "custom-1#ast-2", name: "mcp__memory.search", evidence: "static-only" },
      { callId: "custom-1#ast-3", name: "exec_command", evidence: "static-only" },
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps nested exec tools when a paginated DynamicToolCall completes", () => {
    const input = [
      'await tools.exec_command({ cmd: "pwd" });',
      'await tools.web__run({ search_query: [{ q: "Codex" }] });',
    ].join("\n");
    const loaded = loadCodexSessionRows("/tmp/codex-completed-exec.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-12T08:00:00Z",
        payload: { id: "codex-completed-exec", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "response_item",
        timestamp: "2026-08-12T08:00:01Z",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "exec-1",
          input,
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-12T08:00:02Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          item: {
            type: "DynamicToolCall",
            id: "exec-1",
            namespace: "workspace",
            tool: "exec",
            arguments: input,
            status: "completed",
            success: true,
          },
        },
      },
    ]);

    expect(loaded?.traceEvents).toHaveLength(3);
    expect(loaded?.traceEvents?.[0]).toMatchObject({
      kind: "tool_result",
      title: "workspace.exec · exec_command, web.run",
      callId: "exec-1",
      eventType: "codex.dynamic_tool",
      attributes: {
        nestedTools: ["exec_command", "web__run"],
      },
    });
    expect(loaded?.traceEvents?.slice(1).map((event) => ({
      name: (event.attributes?.tool as Record<string, unknown> | undefined)?.canonicalName,
      parentCallId: (event.attributes?.tool as Record<string, unknown> | undefined)?.parentCallId,
      evidence: (event.attributes?.tool as Record<string, unknown> | undefined)?.executionEvidence,
    }))).toEqual([
      { name: "exec_command", parentCallId: "exec-1", evidence: "static-only" },
      { name: "web.run", parentCallId: "exec-1", evidence: "static-only" },
    ]);
  });

  it("marks runtime-confirmed Code Mode children as parsed for parent summaries", () => {
    const input = [
      'const repo = "/repo";',
      "await Promise.all([",
      '  tools.exec_command({ cmd: "pwd", workdir: repo }),',
      '  tools.exec_command({ cmd: "git status", workdir: repo }),',
      "]);",
    ].join("\n");
    const loaded = loadCodexSessionRows("/tmp/codex-parsed-runtime.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-24T11:55:00Z",
        payload: { id: "codex-parsed-runtime", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "response_item",
        timestamp: "2026-08-24T11:55:01Z",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "exec-parent",
          input,
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      ...["pwd", "git status"].map((command, index) => ({
        type: "event_msg",
        timestamp: `2026-08-24T11:55:0${index + 2}Z`,
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          item: {
            type: "CommandExecution",
            id: `runtime-${index}`,
            command: ["zsh", "-lc", command],
            status: "completed",
            exit_code: 0,
          },
        },
      })),
    ]);

    const children = loaded?.traceEvents?.filter((event) => event.callId?.startsWith("runtime-")) ?? [];
    expect(children).toHaveLength(2);
    expect(children.map((event) => event.attributes?.tool)).toEqual([
      expect.objectContaining({
        canonicalName: "exec_command",
        executionEvidence: "runtime-confirmed",
        parentCallId: "exec-parent",
        parsedFromCodeMode: true,
      }),
      expect.objectContaining({
        canonicalName: "exec_command",
        executionEvidence: "runtime-confirmed",
        parentCallId: "exec-parent",
        parsedFromCodeMode: true,
      }),
    ]);
  });

  it("preserves Codex tool identity and timing across intermediate call events", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-intermediate-tool-event.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-07-30T10:50:23Z",
        payload: { id: "codex-intermediate-tool-event", cwd: "/repo" },
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

    expect(loaded?.traceEvents).toHaveLength(1);
    expect(loaded?.traceEvents?.[0]).toMatchObject({
      kind: "tool_result",
      title: "web.run",
      timestamp: "2026-07-30T10:50:31Z",
      callId: "web-call-1",
      eventType: "codex.function_call",
      status: "completed",
      attributes: {
        startedAt: "2026-07-30T10:50:24Z",
        endedAt: "2026-07-30T10:50:31Z",
        input: {
          search_query: [{ q: "custom tool call input format" }],
          query: "custom tool call input format",
          action: { type: "search" },
        },
        output: { results: [{ title: "Custom tools" }] },
      },
    });
  });

  it("pairs response tools in either order and never guesses for id-less calls", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-response-tools.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-07-30T08:00:00Z",
        payload: { id: "codex-response-tools", cwd: "/repo" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:01Z",
        payload: { type: "custom_tool_call_output", call_id: "reverse-1", output: "done" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:02Z",
        payload: { type: "custom_tool_call", call_id: "reverse-1", name: "reverse", input: "payload" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:03Z",
        payload: { type: "custom_tool_call", name: "same", input: "first" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:04Z",
        payload: { type: "custom_tool_call", name: "same", input: "second" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:05Z",
        payload: {
          type: "local_shell_call",
          id: "shell-1",
          status: "completed",
          action: { type: "exec", command: ["pwd"] },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:06Z",
        payload: {
          type: "tool_search_call",
          call_id: "search-1",
          execution: "search_tools",
          arguments: { query: "docs" },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:07Z",
        payload: {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "search_tools",
          tools: [{ name: "docs.search" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:08Z",
        payload: {
          type: "web_search_call",
          id: "web-response-1",
          status: "completed",
          action: { type: "search", query: "AgentRecall" },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:09Z",
        payload: {
          type: "image_generation_call",
          id: "image-response-1",
          status: "completed",
          revised_prompt: "safe prompt",
          result: "response-opaque-result",
        },
      },
    ]);

    expect(loaded?.traceEvents).toHaveLength(7);
    expect(loaded?.traceEvents?.filter((event) => event.callId === null)).toHaveLength(2);
    expect(loaded?.traceEvents?.find((event) => event.callId === "reverse-1")).toMatchObject({
      title: "reverse",
      eventType: "codex.custom_tool",
      status: "completed",
      attributes: {
        startedAt: "2026-07-30T08:00:01Z",
        endedAt: "2026-07-30T08:00:02Z",
        input: "payload",
        output: "done",
      },
    });
    expect(loaded?.traceEvents?.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "codex.local_shell",
      "codex.tool_search",
      "codex.web_search",
      "codex.image_generation",
    ]));
    expect(JSON.stringify(loaded?.traceEvents)).not.toContain("response-opaque-result");
  });

  it("uses paginated item_completed messages as the authoritative message record", () => {
    const rows = [
      {
        type: "session_meta",
        timestamp: "2026-07-30T08:00:00Z",
        payload: { id: "codex-items", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:01Z",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:01.500Z",
        payload: {
          type: "message",
          id: "injected-context",
          role: "user",
          content: [{ type: "input_text", text: "注入给模型的上下文，不是真实用户 Turn" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:02Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          completed_at_ms: Date.parse("2026-07-30T08:00:02Z"),
          item: {
            type: "UserMessage",
            id: "user-1",
            content: [{ type: "text", text: "只存在于完成项的问题" }],
          },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:02.500Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          completed_at_ms: Date.parse("2026-07-30T08:00:02.500Z"),
          item: {
            type: "HookPrompt",
            id: "hook-1",
            fragments: [{ text: "不能进入对话", hookRunId: "run-1" }],
          },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:03Z",
        payload: {
          type: "message",
          id: "agent-1",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "流式草稿" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:04Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          completed_at_ms: Date.parse("2026-07-30T08:00:04Z"),
          item: {
            type: "AgentMessage",
            id: "agent-1",
            phase: "final_answer",
            content: [{ type: "output_text", text: "权威最终回答" }],
          },
        },
      },
    ];

    const loaded = loadCodexSessionRows("/tmp/codex-items.jsonl", rows);

    expect(loaded?.messages).toMatchObject([
      { role: "user", content: "只存在于完成项的问题", sourceTurnId: "turn-1" },
      { role: "assistant", content: "权威最终回答", sourceTurnId: "turn-1", phase: "final_answer" },
    ]);
    expect(loaded?.codexIncrementalState?.messageProvenance).toEqual([
      { messageIndex: 0, sourceRecordId: "item_completed:user-1" },
      { messageIndex: 1, sourceRecordId: "item_completed:agent-1" },
    ]);
    expect(JSON.stringify(loaded?.messages)).not.toContain("不能进入对话");
  });

  it("cleans paginated item_completed user messages before indexing", () => {
    const userCompleted = (id: string, text: string) => ({
      type: "event_msg",
      timestamp: "2026-08-05T15:45:00Z",
      payload: {
        type: "item_completed",
        turn_id: "turn-1",
        item: { type: "UserMessage", id, content: [{ type: "text", text }] },
      },
    });
    const rows = [
      {
        type: "session_meta",
        timestamp: "2026-08-05T15:44:59Z",
        payload: { id: "codex-noise", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-05T15:45:00Z",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      userCompleted("noise", "<subagent_notification source=\"worker\">done</subagent_notification>"),
      userCompleted(
        "mixed",
        "<timestamp>Friday</timestamp>\n<system_notification><task>done</task></system_notification>\n<user_query>真实输入</user_query>",
      ),
    ];

    const loaded = loadCodexSessionRows("/tmp/codex-noise.jsonl", rows);

    expect(loaded?.messages).toMatchObject([{ role: "user", content: "真实输入" }]);
    expect(loaded?.session.firstQuestion).toBe("真实输入");
    expect(loaded?.session.originalTitle).toBe("真实输入");
  });

  it("normalizes completed Codex tools by strong item id and omits opaque payloads", () => {
    const rows: unknown[] = [
      {
        type: "session_meta",
        timestamp: "2026-07-30T08:00:00Z",
        payload: { id: "codex-tool-items", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:01Z",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:02Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "command-1",
          arguments: JSON.stringify({ command: "ls -la" }),
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:03Z",
        payload: { type: "exec_command_end", call_id: "command-1", command: "ls -la", stdout: "legacy" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:04Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          started_at_ms: Date.parse("2026-07-30T08:00:02Z"),
          completed_at_ms: Date.parse("2026-07-30T08:00:04Z"),
          item: {
            type: "CommandExecution",
            id: "command-1",
            command: ["ls", "-la"],
            cwd: "/repo",
            status: "completed",
            stdout: "authoritative",
            exit_code: 0,
          },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:05Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          completed_at_ms: Date.parse("2026-07-30T08:00:05Z"),
          item: {
            type: "DynamicToolCall",
            id: "dynamic-1",
            namespace: "workspace",
            tool: "lookup",
            arguments: { query: "session", encrypted_payload: "must-not-index" },
            status: "completed",
            content_items: [{ text: "found" }],
            success: true,
          },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:06Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          completed_at_ms: Date.parse("2026-07-30T08:00:06Z"),
          item: {
            type: "ImageGeneration",
            id: "image-1",
            status: "completed",
            revised_prompt: "diagram",
            result: "opaque-image-result",
            saved_path: "/tmp/diagram.png",
          },
        },
      },
    ];
    const additionalItems = [
      {
        type: "McpToolCall",
        id: "mcp-1",
        server: "docs",
        tool: "search",
        arguments: { query: "session" },
        status: "completed",
        result: { content: [{ type: "text", text: "found" }] },
        duration: "150ms",
      },
      {
        type: "WebSearch",
        id: "web-1",
        query: "Codex protocol",
        action: { type: "search", query: "Codex protocol" },
        results: [{ title: "Protocol" }],
      },
      { type: "ImageView", id: "view-1", path: "file:///repo/diagram.png" },
      {
        type: "FileChange",
        id: "patch-1",
        changes: { "src/app.ts": { type: "update" } },
        status: "completed",
        auto_approved: true,
        stdout: "Done!",
      },
      {
        type: "Extension",
        kind: "image_gen.generation",
        id: "extension-image-1",
        status: "completed",
        revisedPrompt: "safe diagram",
        result: "extension-opaque-result",
        savedPath: "/tmp/extension.png",
      },
      {
        type: "Extension",
        kind: "web.search",
        id: "extension-web-1",
        query: "AgentRecall",
        action: { type: "search", query: "AgentRecall" },
        results: [{ title: "AgentRecall" }],
      },
      { type: "Extension", kind: "clock.sleep", id: "sleep-1", durationMs: 250 },
      { type: "Extension", kind: "future.unknown", id: "unknown-1", payload: "ignored" },
    ];
    rows.push(...additionalItems.map((item, index) => ({
      type: "event_msg",
      timestamp: new Date(Date.parse("2026-07-30T08:00:07Z") + index * 1_000).toISOString(),
      payload: {
        type: "item_completed",
        turn_id: "turn-1",
        completed_at_ms: Date.parse("2026-07-30T08:00:07Z") + index * 1_000,
        item,
      },
    })));

    const loaded = loadCodexSessionRows("/tmp/codex-tool-items.jsonl", rows);

    expect(loaded?.traceEvents).toHaveLength(11);
    expect(loaded?.traceEvents?.filter((event) => event.callId === "command-1")).toHaveLength(1);
    expect(loaded?.traceEvents?.find((event) => event.callId === "command-1")).toMatchObject({
      kind: "tool_result",
      eventType: "codex.command_execution",
      status: "completed",
      sourceTurnId: "turn-1",
      attributes: {
        durationMs: 2_000,
        codex: { sourceItemId: "item_completed:command-1", rawType: "commandexecution" },
      },
    });
    expect(loaded?.traceEvents?.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "codex.dynamic_tool",
      "codex.mcp_tool",
      "codex.web_search",
      "codex.image_view",
      "codex.file_change",
      "codex.image_generation",
      "codex.extension.sleep",
    ]));
    expect(loaded?.traceEvents?.find((event) => event.callId === "sleep-1")?.title).toBe("wait · 250 ms");
    expect(JSON.stringify(loaded?.traceEvents)).not.toContain("must-not-index");
    expect(JSON.stringify(loaded?.traceEvents)).not.toContain("opaque-image-result");
    expect(JSON.stringify(loaded?.traceEvents)).not.toContain("extension-opaque-result");
  });

  it("normalizes safe reasoning, annotation, collaboration, and context traces", () => {
    const completed = (item: Record<string, unknown>, second: number) => ({
      type: "event_msg",
      timestamp: `2026-07-30T08:00:${String(second).padStart(2, "0")}Z`,
      payload: {
        type: "item_completed",
        turn_id: "turn-1",
        completed_at_ms: Date.parse(`2026-07-30T08:00:${String(second).padStart(2, "0")}Z`),
        item,
      },
    });
    const settings = {
      model: "gpt-5",
      cwd: "/repo",
      approval_policy: "on_request",
      sandbox_policy: { type: "workspace-write" },
      permission_profile: { type: "workspace-write" },
      reasoning_effort: "high",
      personality: "pragmatic",
      collaboration_mode: { mode: "default" },
      world_state: "must-not-index-world-state",
    };
    const rows: unknown[] = [
      {
        type: "session_meta",
        timestamp: "2026-07-30T08:00:00Z",
        payload: { id: "codex-rich", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:01Z",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:02Z",
        payload: {
          type: "reasoning",
          id: "reason-1",
          summary: [{ type: "summary_text", text: "检查索引边界" }],
          content: [{ type: "reasoning_text", text: "must-not-index-raw-reasoning" }],
          encrypted_content: "must-not-index-encrypted-reasoning",
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:03Z",
        payload: { type: "agent_reasoning", text: "检查索引边界" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:03.500Z",
        payload: { type: "agent_reasoning_raw_content", text: "must-not-index-legacy-raw" },
      },
      completed({
        type: "Reasoning",
        id: "reason-1",
        summary_text: ["检查索引边界"],
        raw_content: ["must-not-index-item-raw"],
      }, 4),
      completed({ type: "Plan", id: "plan-1", text: "1. 检查\n2. 修复" }, 5),
      completed({
        type: "EnteredReviewMode",
        id: "review-in",
        target: { type: "uncommitted_changes" },
        user_facing_hint: "Reviewing changes",
      }, 6),
      completed({
        type: "ExitedReviewMode",
        id: "review-out",
        review_output: { findings: "No blockers" },
      }, 7),
      completed({
        type: "CollabAgentToolCall",
        id: "collab-1",
        tool: "spawn_agent",
        status: "completed",
        sender_thread_id: "parent-thread",
        receiver_thread_ids: ["child-thread"],
        receiver_agents: [{ thread_id: "child-thread", agent_nickname: "reviewer" }],
        prompt: "must-not-index-collab-prompt",
        agents_states: { "child-thread": "completed" },
      }, 8),
      completed({
        type: "SubAgentActivity",
        id: "activity-1",
        kind: "started",
        agent_thread_id: "child-thread",
        agent_path: "reviewer",
      }, 9),
      completed({ type: "ContextCompaction", id: "compact-1" }, 10),
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:11Z",
        payload: {
          type: "agent_message",
          id: "agent-message-1",
          author: "reviewer",
          recipient: "parent",
          content: [{ type: "input_text", text: "Review complete" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T08:00:12Z",
        payload: {
          type: "agent_message",
          id: "agent-message-encrypted",
          author: "reviewer",
          recipient: "parent",
          content: [{ type: "encrypted_content", encrypted_content: "must-not-index-agent-message" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:13Z",
        payload: {
          type: "thread_goal_updated",
          turnId: "turn-1",
          goal: {
            objective: "Finish parser",
            status: "active",
            tokenBudget: 2_000,
            tokensUsed: 500,
            timeUsedSeconds: 10,
            private_state: "must-not-index-goal-private-state",
          },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:14Z",
        payload: { type: "thread_settings_applied", thread_settings: settings },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T08:00:15Z",
        payload: { type: "thread_settings_applied", thread_settings: settings },
      },
      {
        type: "turn_context",
        timestamp: "2026-07-30T08:00:16Z",
        payload: { ...settings, turn_id: "turn-1", timezone: "Asia/Shanghai" },
      },
    ];

    const loaded = loadCodexSessionRows("/tmp/codex-rich.jsonl", rows);
    const eventTypes = loaded?.traceEvents?.map((event) => event.eventType) ?? [];
    const serialized = JSON.stringify(loaded?.traceEvents);

    expect(eventTypes.filter((type) => type === "codex.reasoning_summary")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "codex.thread.settings")).toHaveLength(2);
    expect(eventTypes).toEqual(expect.arrayContaining([
      "codex.plan",
      "codex.review.entered",
      "codex.review.exited",
      "codex.goal.updated",
      "codex.context.compaction",
      "codex.collaboration.tool",
      "codex.collaboration.activity",
      "codex.collaboration.message",
    ]));
    expect(serialized).toContain("Review complete");
    expect(serialized).toContain("permissionProfile");
    expect(serialized).toContain("must-not-index-agent-message");
    expect(serialized).not.toContain("must-not-index-raw-reasoning");
    expect(serialized).not.toContain("must-not-index-encrypted-reasoning");
    expect(serialized).not.toContain("must-not-index-legacy-raw");
    expect(serialized).not.toContain("must-not-index-item-raw");
    expect(serialized).not.toContain("must-not-index-collab-prompt");
    expect(serialized).not.toContain("must-not-index-goal-private-state");
    expect(serialized).not.toContain("must-not-index-world-state");
  });

  it("caps large Codex trace details during loading", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    const stdout = "x".repeat(TRACE_DETAIL_PREVIEW_MAX_CHARS + 50);
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-trace-large", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:01:00Z",
          payload: {
            type: "exec_command_end",
            command: "npm test",
            exit_code: 0,
            stdout,
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);
    const detail = loaded?.traceEvents?.[0]?.detail || "";

    expect(detail.length).toBeLessThanOrEqual(TRACE_DETAIL_PREVIEW_MAX_CHARS);
    expect(detail).toContain("Indexed preview truncated");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses old and new Codex metadata lines", () => {
    expect(
      parseCodexSessionMetaLine({
        type: "session_meta",
        timestamp: "2026-06-01T10:00:00Z",
        payload: { id: "new-id", cwd: "/new", title: "内嵌标题 🚀", git: { branch: "feat/session-tags" } },
      }),
    ).toMatchObject({
      id: "new-id",
      projectPath: "/new",
      title: "内嵌标题 🚀",
      gitBranch: "feat/session-tags",
    });

    expect(
      parseCodexSessionMetaLine({
        id: "old-id",
        timestamp: "2025-01-01T00:00:00Z",
        instructions: "...",
        git: { cwd: "/old", branch: "legacy/branch" },
      }),
    ).toMatchObject({ id: "old-id", projectPath: "/old", gitBranch: "legacy/branch" });
  });

  it("finds Codex metadata and branch information after an earlier rollout row", () => {
    const loaded = loadCodexSessionRows("/tmp/later-meta.jsonl", [
      { type: "event_msg", timestamp: "2026-06-01T09:59:59Z", payload: { type: "startup" } },
      {
        type: "session_meta",
        timestamp: "2026-06-01T10:00:00Z",
        payload: { id: "later-meta", cwd: "/repo", git: { branch: "feat/later-meta" } },
      },
      {
        type: "response_item",
        timestamp: "2026-06-01T10:01:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "later metadata" }] },
      },
    ]);

    expect(loaded?.session).toMatchObject({
      rawId: "later-meta",
      projectPath: "/repo",
      gitBranch: "feat/later-meta",
    });
  });

  it("reuses previously resolved Codex metadata instead of rescanning the rows", () => {
    const loaded = loadCodexSessionRows(
      "/tmp/pre-resolved-meta.jsonl",
      [
        {
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "reuse metadata" }] },
        },
      ],
      {
        sessionMeta: {
          id: "pre-resolved-meta",
          projectPath: "/repo",
          ts: Date.parse("2026-06-01T10:00:00Z"),
          gitBranch: "feat/pre-resolved",
          isSubagent: false,
          parentSessionId: null,
        },
      },
    );

    expect(loaded?.session).toMatchObject({
      rawId: "pre-resolved-meta",
      projectPath: "/repo",
      gitBranch: "feat/pre-resolved",
    });
  });

  it("prefers an explicit Codex title over the embedded metadata title", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-title-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-title", cwd: "/repo", title: "内嵌标题" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "首问标题" }] },
        }),
      ].join("\n"),
    );

    expect(loadCodexSessionFile(filePath)?.session.originalTitle).toBe("内嵌标题");
    expect(loadCodexSessionFile(filePath, "显式标题")?.session.originalTitle).toBe("显式标题");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("decodes percent-encoded Codex titles from the first question or index name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-encoded-title-"));
    const filePath = path.join(dir, "rollout.jsonl");
    const encoded = "https://example.com/p/1?from=search#1.2.1-%E4%BD%BF%E7%94%A8%E8%85%BE%E8%AE%AF%E4%BA";
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-encoded-title", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: encoded }] },
        }),
      ].join("\n"),
    );

    expect(loadCodexSessionFile(filePath)?.session.originalTitle)
      .toBe("https://example.com/p/1?from=search#1.2.1-使用腾讯");
    expect(loadCodexSessionFile(filePath, encoded)?.session.originalTitle)
      .toBe("https://example.com/p/1?from=search#1.2.1-使用腾讯");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads TCodex sessions with a separate source and session key namespace", () => {
    const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-tcodex-"));
    const sessionDir = path.join(codexDir, "sessions", "2026", "06", "01");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "tcodex-1", cwd: "/internal", git: { branch: "feat/internal" } },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "内部会话" }] },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessions(codexDir, "tcodex-cli");

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "tcodex:tcodex-1",
      rawId: "tcodex-1",
      source: "tcodex-cli",
      projectPath: "/internal",
      gitBranch: "feat/internal",
    });

    fs.rmSync(codexDir, { recursive: true, force: true });
  });
});

describe("Claude session loading", () => {
  it("shows only the current Claude parent chain and its tool trace", () => {
    const rows = [
      {
        type: "user",
        uuid: "root",
        parentUuid: null,
        cwd: "/repo",
        message: { role: "user", content: "根问题" },
      },
      {
        type: "assistant",
        uuid: "old-answer",
        parentUuid: "root",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "旧回答" }, { type: "tool_use", id: "old-tool", name: "OldTool", input: { query: "old" } }],
        },
      },
      {
        type: "user",
        uuid: "replacement",
        parentUuid: "root",
        message: { role: "user", content: "替代问题" },
      },
      {
        type: "assistant",
        uuid: "current-answer",
        parentUuid: "replacement",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "当前回答" }, { type: "tool_use", id: "new-tool", name: "NewTool", input: { query: "new" } }],
        },
      },
    ];

    const loaded = loadClaudeCliSessionRows("/tmp/claude-branch.jsonl", rows, { rawId: "claude-branch" });

    expect(loaded?.messages.map((entry) => entry.content)).toEqual(["根问题", "替代问题", "当前回答"]);
    expect(loaded?.traceEvents?.map((entry) => entry.title)).toEqual(["NewTool · new"]);
  });

  it("falls back to the complete Claude sequence when the parent graph is incomplete or cyclic", () => {
    const incomplete = [
      { type: "user", uuid: "root", parentUuid: null, message: { role: "user", content: "根问题" } },
      { type: "assistant", uuid: "orphan", parentUuid: "missing", message: { role: "assistant", content: "孤立回答" } },
    ];
    const cyclic = [
      { type: "user", uuid: "a", parentUuid: "b", message: { role: "user", content: "问题 A" } },
      { type: "assistant", uuid: "b", parentUuid: "a", message: { role: "assistant", content: "回答 B" } },
    ];

    expect(loadClaudeCliSessionRows("/tmp/claude-incomplete.jsonl", incomplete)?.messages.map((entry) => entry.content)).toEqual([
      "根问题",
      "孤立回答",
    ]);
    expect(loadClaudeCliSessionRows("/tmp/claude-cycle.jsonl", cyclic)?.messages.map((entry) => entry.content)).toEqual([
      "问题 A",
      "回答 B",
    ]);
  });

  it("discovers Claude subagent files and links them to the parent session", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-subagent-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    const subagentsDir = path.join(projectDir, "parent-1", "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentsDir, "agent-child-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          agentId: "child-1",
          sessionId: "parent-1",
          isSidechain: true,
          cwd: "/repo",
          message: { role: "user", content: "Inspect the parser" },
        }),
        JSON.stringify({
          type: "assistant",
          agentId: "child-1",
          sessionId: "parent-1",
          isSidechain: true,
          message: { role: "assistant", content: "Parser inspected" },
        }),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      rawId: "child-1",
      projectPath: "/repo",
      isSubagent: true,
      parentSessionId: "parent-1",
    });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("reads ai-title metadata without exposing it as a message or changing the explicit source", () => {
    const loaded = loadClaudeCliSessionRows(
      "/tmp/claude-title.jsonl",
      [
        { type: "ai-title", aiTitle: "Claude 标题 ✨", sessionId: "claude-title" },
        {
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          message: { role: "user", content: "真实问题" },
        },
      ],
      { rawId: "claude-title", source: "tclaude-cli" },
    );

    expect(loaded?.session).toMatchObject({
      source: "tclaude-cli",
      originalTitle: "Claude 标题 ✨",
    });
    expect(loaded?.messages.map((message) => message.content)).toEqual(["真实问题"]);
  });

  it("uses the first real Claude prompt after local command caveats as the default title", () => {
    const loaded = loadClaudeCliSessionRows(
      "/tmp/claude-local-command-caveat.jsonl",
      [
        {
          type: "user",
          timestamp: "2026-07-28T10:00:00Z",
          cwd: "/repo",
          message: {
            role: "user",
            content: "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond</local-command-caveat>",
          },
        },
        {
          type: "user",
          timestamp: "2026-07-28T10:01:00Z",
          cwd: "/repo",
          message: { role: "user", content: "修复图片导出失败" },
        },
      ],
      { rawId: "claude-local-command-caveat" },
    );

    expect(loaded?.session).toMatchObject({
      originalTitle: "修复图片导出失败",
      firstQuestion: "修复图片导出失败",
    });
    expect(loaded?.messages.map((message) => message.content)).toEqual(["修复图片导出失败"]);
  });

  it("prefers the latest Claude Code custom title over the AI title", () => {
    const loaded = loadClaudeCliSessionRows(
      "/tmp/claude-custom-title.jsonl",
      [
        { type: "ai-title", aiTitle: "自动生成标题", sessionId: "claude-custom-title" },
        { type: "custom-title", customTitle: "第一次重命名", sessionId: "claude-custom-title" },
        {
          type: "user",
          timestamp: "2026-07-29T02:35:40Z",
          cwd: "/repo",
          message: { role: "user", content: "真实问题" },
        },
        { type: "custom-title", customTitle: "最终会话名称", sessionId: "claude-custom-title" },
      ],
      { rawId: "claude-custom-title" },
    );

    expect(loaded?.session.originalTitle).toBe("最终会话名称");
    expect(loaded?.messages.map((message) => message.content)).toEqual(["真实问题"]);
  });

  it("extracts branch metadata from Claude Code jsonl rows", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "claude-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          sessionId: "claude-1",
          gitBranch: "feat/claude-tags",
          message: { role: "user", content: "修复会话列表" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T10:01:00Z",
          cwd: "/repo",
          sessionId: "claude-1",
          gitBranch: "feat/claude-tags",
          message: { role: "assistant", content: "我来处理" },
        }),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "claude:claude-1",
      rawId: "claude-1",
      source: "claude-cli",
      projectPath: "/repo",
      gitBranch: "feat/claude-tags",
    });

    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("loads TClaude sessions with a separate source and session key namespace", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-tclaude-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "tclaude-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          sessionId: "tclaude-1",
          gitBranch: "feat/internal",
          message: { role: "user", content: "内部 Claude 会话" },
        }),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir, "tclaude-cli");

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "tclaude:tclaude-1",
      rawId: "tclaude-1",
      source: "tclaude-cli",
      projectPath: "/repo",
      gitBranch: "feat/internal",
    });

    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("extracts Claude token usage from assistant message usage without double counting duplicate message ids", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    const assistant = {
      type: "assistant",
      timestamp: "2026-06-01T10:01:00Z",
      cwd: "/repo",
      sessionId: "claude-token-1",
      message: {
        id: "msg_1",
        role: "assistant",
        content: "我来处理",
        usage: {
          input_tokens: 900,
          output_tokens: 120,
          cache_read_input_tokens: 300,
          reasoning_output_tokens: 40,
        },
      },
    };
    fs.writeFileSync(
      path.join(projectDir, "claude-token-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          sessionId: "claude-token-1",
          message: { role: "user", content: "统计 tokens" },
        }),
        JSON.stringify(assistant),
        JSON.stringify(assistant),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir);

    expect(loaded[0].session.tokenUsage).toEqual({
      inputTokens: 900,
      outputTokens: 120,
      cachedInputTokens: 300,
      reasoningOutputTokens: 40,
      totalTokens: 1360,
    });
    expect(loaded[0].tokenEvents).toEqual([
      {
        dedupeKey: "claude-code:msg_1",
        timestamp: new Date("2026-06-01T10:01:00Z").getTime(),
        inputTokens: 900,
        outputTokens: 120,
        cachedInputTokens: 300,
        reasoningOutputTokens: 40,
        totalTokens: 1360,
      },
    ]);

    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("counts cache_creation_input_tokens as processed input", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "claude-cache-create.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          sessionId: "claude-cache-create",
          message: { role: "user", content: "首轮请求会写入缓存" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T10:01:00Z",
          cwd: "/repo",
          sessionId: "claude-cache-create",
          message: {
            id: "msg_cache",
            role: "assistant",
            content: "好的",
            usage: {
              input_tokens: 500,
              output_tokens: 100,
              cache_creation_input_tokens: 2000,
              cache_read_input_tokens: 300,
            },
          },
        }),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir);

    expect(loaded[0].session.tokenUsage).toEqual({
      inputTokens: 500,
      outputTokens: 100,
      cachedInputTokens: 300,
      cacheCreationInputTokens: 2000,
      reasoningOutputTokens: 0,
      totalTokens: 2900,
    });

    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("extracts Claude tool_use and tool_result blocks as trace events", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "claude-trace-1.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T10:01:00Z",
          cwd: "/repo",
          sessionId: "claude-trace-1",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "我先读文件" },
              { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/repo/src/App.tsx" } },
              { type: "tool_use", id: "tool-2", name: "Write", input: { file_path: "/repo/src/App.tsx" } },
              { type: "tool_use", id: "tool-3", name: "Bash", input: { command: "npm test" } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:01:01Z",
          cwd: "/repo",
          sessionId: "claude-trace-1",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "export function App() {}" },
              { type: "tool_result", tool_use_id: "tool-2", content: "permission denied", is_error: true },
            ],
          },
        }),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir);

    expect(loaded[0].messages.map((message) => message.content)).toEqual(["我先读文件"]);
    expect(loaded[0].traceEvents).toMatchObject([
      {
        kind: "tool_call",
        source: "claude",
        title: "Read · /repo/src/App.tsx",
        callId: "tool-1",
        status: "running",
      },
      { kind: "tool_call", callId: "tool-2", status: "running" },
      { kind: "tool_call", callId: "tool-3", status: "running" },
      { kind: "tool_result", callId: "tool-1", status: "completed" },
      { kind: "tool_result", callId: "tool-2", status: "failed" },
    ]);
    expect(loaded[0].traceEvents?.[3].detail).toContain("export function App");

    fs.rmSync(claudeDir, { recursive: true, force: true });
  });
});

describe("CodeBuddy session loading", () => {
  it("loads CodeBuddy rows without a temporary file", () => {
    const rows = [
      { type: "ai-title", aiTitle: "远程 CodeBuddy", sessionId: "cb-remote", cwd: "/repo" },
      {
        id: "user-1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "远程问题" }],
        sessionId: "cb-remote",
        cwd: "/repo",
        timestamp: 1_780_000_000_000,
      },
    ];
    const loaded = loadCodeBuddyCliSessionRows(
      "/home/me/.codebuddy/projects/repo/cb-remote.jsonl",
      rows,
      { mtimeMs: 1_780_000_000_000, size: 100 },
    );

    expect(loaded?.session).toMatchObject({
      rawId: "cb-remote",
      source: "codebuddy-cli",
      originalTitle: "远程 CodeBuddy",
      projectPath: "/repo",
      gitBranch: null,
    });
  });

  it("prefers an embedded gitBranch on CodeBuddy rows when present", () => {
    const loaded = loadCodeBuddyCliSessionRows(
      "/home/me/.codebuddy/projects/repo/cb-embedded.jsonl",
      [
        {
          id: "user-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "带分支元数据" }],
          sessionId: "cb-embedded",
          cwd: "/repo",
          gitBranch: "feat/codebuddy-tags",
          timestamp: 1_780_000_000_000,
        },
      ],
      { mtimeMs: 1_780_000_000_000, size: 100 },
    );

    expect(loaded?.session.gitBranch).toBe("feat/codebuddy-tags");
  });

  it("resolves CodeBuddy gitBranch from the session cwd .git/HEAD when rows omit it", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-git-"));
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/fix/codebuddy-branch\n");

    const loaded = loadCodeBuddyCliSessionRows(
      "/home/me/.codebuddy/projects/repo/cb-git-head.jsonl",
      [
        {
          id: "user-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "从 cwd 解析分支" }],
          sessionId: "cb-git-head",
          cwd: repoDir,
          timestamp: 1_780_000_000_000,
        },
      ],
      { mtimeMs: 1_780_000_000_000, size: 100 },
    );

    expect(loaded?.session).toMatchObject({
      projectPath: repoDir,
      gitBranch: "fix/codebuddy-branch",
    });

    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("resolves CodeBuddy gitBranch through a gitdir worktree pointer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-worktree-"));
    const gitDir = path.join(root, "real-git");
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/worktree/feature\n");
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);

    const loaded = loadCodeBuddyCliSessionRows(
      "/home/me/.codebuddy/projects/repo/cb-worktree.jsonl",
      [
        {
          id: "user-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "worktree 分支" }],
          sessionId: "cb-worktree",
          cwd: worktree,
          timestamp: 1_780_000_000_000,
        },
      ],
      { mtimeMs: 1_780_000_000_000, size: 100 },
    );

    expect(loaded?.session.gitBranch).toBe("worktree/feature");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads one CodeBuddy CLI jsonl file with the same behavior as the iterator", () => {
    const codeBuddyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-file-"));
    const filePath = path.join(codeBuddyDir, "codebuddy-file.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "ai-title",
          aiTitle: "单文件标题",
          sessionId: "codebuddy-file",
          cwd: "/repo/单文件",
        }),
        JSON.stringify({
          id: "msg-user",
          timestamp: 1_780_321_278_404,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "读取单文件" }],
          sessionId: "codebuddy-file",
          cwd: "/repo/单文件",
        }),
      ].join("\n"),
    );

    const loaded = loadCodeBuddyCliSessionFile(filePath);

    expect(loaded?.session).toMatchObject({
      rawId: "codebuddy-file",
      source: "codebuddy-cli",
      projectPath: "/repo/单文件",
      originalTitle: "单文件标题",
    });
    expect(loaded?.messages.map((message) => message.content)).toEqual(["读取单文件"]);

    fs.rmSync(codeBuddyDir, { recursive: true, force: true });
  });

  it("loads CodeBuddy CLI jsonl sessions with a separate source namespace", () => {
    const codeBuddyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-"));
    const projectDir = path.join(codeBuddyDir, "projects", "Users-xjx");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "codebuddy-1.jsonl"),
      [
        JSON.stringify({
          id: "msg-user",
          timestamp: 1_780_321_278_404,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "接入 CodeBuddy CLI" }],
          sessionId: "codebuddy-1",
          cwd: "/repo",
        }),
        JSON.stringify({
          id: "msg-assistant",
          parentId: "msg-user",
          timestamp: 1_780_321_303_135,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "我来处理" }],
          providerData: {
            messageId: "provider-message-1",
            // Real CodeBuddy shape: camelCase totals where inputTokens already
            // includes cached, outputTokens already includes reasoning, and the
            // detail breakdowns are arrays.
            usage: {
              requests: 1,
              inputTokens: 120,
              outputTokens: 30,
              totalTokens: 150,
              inputTokensDetails: [{ cached_tokens: 10 }],
              outputTokensDetails: [{ reasoning_tokens: 5 }],
            },
          },
          sessionId: "codebuddy-1",
          cwd: "/repo",
        }),
      ].join("\n"),
    );

    const loaded = loadCodeBuddyCliSessions(codeBuddyDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "codebuddy:codebuddy-1",
      rawId: "codebuddy-1",
      source: "codebuddy-cli",
      projectPath: "/repo",
      firstQuestion: "接入 CodeBuddy CLI",
      originalTitle: "接入 CodeBuddy CLI",
      timestamp: 1_780_321_278_404,
      // input split into non-cached (110) + cached (10); output into
      // non-reasoning (25) + reasoning (5); total matches CodeBuddy's 150.
      tokenUsage: {
        inputTokens: 110,
        outputTokens: 25,
        cachedInputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 150,
      },
    });
    expect(loaded[0].messages.map((message) => message.content)).toEqual(["接入 CodeBuddy CLI", "我来处理"]);
    expect(loaded[0].tokenEvents).toEqual([
      {
        dedupeKey: "codebuddy:provider-message-1",
        timestamp: 1_780_321_303_135,
        inputTokens: 110,
        outputTokens: 25,
        cachedInputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 150,
      },
    ]);

    fs.rmSync(codeBuddyDir, { recursive: true, force: true });
  });

  it("sums token usage from function_call records, counting parallel tool calls separately", () => {
    const codeBuddyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-fc-"));
    const projectDir = path.join(codeBuddyDir, "projects", "Users-xjx");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "codebuddy-fc.jsonl"),
      [
        JSON.stringify({
          id: "msg-user",
          timestamp: 1_780_000_000_000,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "edit some files" }],
          sessionId: "codebuddy-fc",
          cwd: "/repo",
        }),
        // A tool-ending assistant turn keeps no usage on the message; the usage
        // lives on each function_call. Two parallel tool calls in one turn share
        // a messageId but are separately billed requests keyed by callId.
        JSON.stringify({
          id: "asst-1",
          timestamp: 1_780_000_001_000,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
          providerData: { messageId: "m-1", model: "gpt" },
          sessionId: "codebuddy-fc",
          cwd: "/repo",
        }),
        JSON.stringify({
          id: "fc-1",
          callId: "call-a",
          timestamp: 1_780_000_001_100,
          type: "function_call",
          name: "Read",
          providerData: {
            messageId: "m-1",
            usage: { requests: 1, inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
          },
          sessionId: "codebuddy-fc",
          cwd: "/repo",
        }),
        JSON.stringify({
          id: "fc-2",
          callId: "call-b",
          timestamp: 1_780_000_001_200,
          type: "function_call",
          name: "Edit",
          providerData: {
            messageId: "m-1",
            usage: { requests: 1, inputTokens: 2000, outputTokens: 20, totalTokens: 2020 },
          },
          sessionId: "codebuddy-fc",
          cwd: "/repo",
        }),
        // A later text-ending turn keeps usage on the assistant message itself.
        JSON.stringify({
          id: "asst-2",
          timestamp: 1_780_000_002_000,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
          providerData: {
            messageId: "m-2",
            usage: { requests: 1, inputTokens: 3000, outputTokens: 30, totalTokens: 3030 },
          },
          sessionId: "codebuddy-fc",
          cwd: "/repo",
        }),
      ].join("\n"),
    );

    const loaded = loadCodeBuddyCliSessions(codeBuddyDir);

    expect(loaded).toHaveLength(1);
    const session = loaded[0]!;
    // 1010 + 2020 (two parallel tool calls) + 3030 (text turn) = 6060.
    expect(session.session.tokenUsage).toEqual({
      inputTokens: 6000,
      outputTokens: 60,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 6060,
    });
    expect(session.tokenEvents?.map((event) => event.dedupeKey).sort()).toEqual([
      "codebuddy:call-a",
      "codebuddy:call-b",
      "codebuddy:m-2",
    ]);

    fs.rmSync(codeBuddyDir, { recursive: true, force: true });
  });

  it("reads token usage from the OpenAI-style rawUsage fallback", () => {
    const codeBuddyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-raw-"));
    const projectDir = path.join(codeBuddyDir, "projects", "Users-xjx");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "codebuddy-raw.jsonl"),
      [
        JSON.stringify({
          id: "u",
          timestamp: 1_780_321_278_404,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
          sessionId: "codebuddy-raw",
          cwd: "/repo",
        }),
        JSON.stringify({
          id: "a",
          timestamp: 1_780_321_303_135,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
          providerData: {
            messageId: "pm-2",
            rawUsage: {
              prompt_tokens: 200,
              completion_tokens: 50,
              total_tokens: 250,
              prompt_tokens_details: { cached_tokens: 40 },
              completion_tokens_details: { reasoning_tokens: 8 },
            },
          },
          sessionId: "codebuddy-raw",
          cwd: "/repo",
        }),
      ].join("\n"),
    );

    const loaded = loadCodeBuddyCliSessions(codeBuddyDir);

    expect(loaded[0].session.tokenUsage).toEqual({
      inputTokens: 160,
      outputTokens: 42,
      cachedInputTokens: 40,
      reasoningOutputTokens: 8,
      totalTokens: 250,
    });

    fs.rmSync(codeBuddyDir, { recursive: true, force: true });
  });

  it("prefers the CodeBuddy ai-title over slash-command first messages", () => {
    const codeBuddyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-title-"));
    const projectDir = path.join(codeBuddyDir, "projects", "Users-xjx");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "codebuddy-title.jsonl"),
      [
        // Root bootstrap "code" message is dropped, and the first real user
        // message is a slash command that should NOT become the title.
        JSON.stringify({
          id: "root",
          timestamp: 1_780_321_278_000,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "code" }],
          sessionId: "codebuddy-title",
          cwd: "/repo",
        }),
        JSON.stringify({
          id: "cmd",
          parentId: "root",
          timestamp: 1_780_321_278_404,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "/model" }],
          sessionId: "codebuddy-title",
          cwd: "/repo",
        }),
        JSON.stringify({
          type: "ai-title",
          aiTitle: "Switch the active model",
          sessionId: "codebuddy-title",
          cwd: "/repo",
        }),
      ].join("\n"),
    );

    const loaded = loadCodeBuddyCliSessions(codeBuddyDir);

    expect(loaded[0].session.originalTitle).toBe("Switch the active model");

    fs.rmSync(codeBuddyDir, { recursive: true, force: true });
  });
});

describe("WorkBuddy session loading", () => {
  it("keeps WorkBuddy opt-in and indexes messages, traces, usage, and subagents", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-workbuddy-"));
    const workBuddyDir = path.join(homeDir, ".workbuddy");
    const projectDir = path.join(workBuddyDir, "projects", "stored-project");
    const parentId = "11111111-1111-4111-8111-111111111111";
    const mainPath = path.join(projectDir, `${parentId}.jsonl`);
    const subagentPath = path.join(projectDir, parentId, "subagents", "2025.01.01.jsonl");
    const invalidMainPath = path.join(projectDir, "invalid.main.jsonl");
    const invalidParentPath = path.join(projectDir, "invalid.parent", "subagents", "child.jsonl");
    const ignoredPath = path.join(projectDir, parentId, "tool-results", "not-a-session.jsonl");
    fs.mkdirSync(path.dirname(subagentPath), { recursive: true });
    fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
    fs.writeFileSync(
      mainPath,
      [
        JSON.stringify({ type: "ai-title", aiTitle: "WorkBuddy implementation", sessionId: "wrong-row-id" }),
        JSON.stringify({
          id: "user-1",
          timestamp: 1_780_000_000_000,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "code" }],
          cwd: "/repo/workbuddy",
          sessionId: "wrong-row-id",
        }),
        JSON.stringify({
          id: "assistant-1",
          timestamp: 1_780_000_001_000,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I will inspect it." }],
          providerData: {
            messageId: "provider-assistant-1",
            usage: { inputTokens: 32_221, outputTokens: 4 },
            rawUsage: { prompt_cache_hit_tokens: 32_000 },
          },
        }),
        JSON.stringify({
          id: "assistant-duplicate",
          timestamp: 1_780_000_001_100,
          type: "message",
          role: "assistant",
          content: [],
          providerData: {
            messageId: "provider-assistant-1",
            usage: { inputTokens: 32_221, outputTokens: 4 },
            rawUsage: { prompt_cache_hit_tokens: 32_000 },
          },
        }),
        JSON.stringify({
          id: "shared-response-1",
          timestamp: 1_780_000_002_000,
          type: "function_call",
          name: "Bash",
          callId: "call-1",
          arguments: "{\"command\":\"pwd\"}",
          providerData: {
            messageId: "provider-tool-1",
            rawUsage: {
              prompt_tokens: 1_000,
              completion_tokens: 100,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 100,
              prompt_cache_write_tokens: 80,
              completion_thinking_tokens: 20,
              completion_tokens_details: { reasoning_tokens: 20 },
            },
          },
        }),
        JSON.stringify({
          id: "shared-response-1",
          timestamp: 1_780_000_002_100,
          type: "function_call",
          name: "Read",
          callId: "call-2",
          arguments: { path: "/repo/workbuddy/README.md", file_path: "/wrong-priority.md" },
          providerData: {
            messageId: "provider-tool-1",
            rawUsage: {
              prompt_tokens: 1_000,
              completion_tokens: 100,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 100,
              prompt_cache_write_tokens: 80,
              completion_thinking_tokens: 20,
              completion_tokens_details: { reasoning_tokens: 20 },
            },
          },
        }),
        JSON.stringify({
          id: "reasoning-1",
          timestamp: 1_780_000_002_200,
          type: "reasoning",
          providerData: {
            messageId: "provider-tool-1",
            rawUsage: {
              prompt_tokens: 1_000,
              completion_tokens: 100,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 100,
              prompt_cache_write_tokens: 80,
              completion_thinking_tokens: 20,
              completion_tokens_details: { reasoning_tokens: 20 },
            },
          },
        }),
        JSON.stringify({
          id: "shared-response-1",
          timestamp: 1_780_000_002_300,
          type: "function_call",
          name: "IgnoredWithoutCallId",
          arguments: { path: "/private/ignored" },
        }),
        JSON.stringify({
          id: "reasoning-message-usage",
          timestamp: 1_780_000_002_400,
          type: "reasoning",
          providerData: { messageId: "provider-message-usage" },
          message: {
            usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 10 },
          },
        }),
        JSON.stringify({
          id: "result-1",
          timestamp: 1_780_000_003_000,
          type: "function_call_result",
          callId: "call-1",
          output: { type: "text", text: "/repo/workbuddy" },
        }),
        JSON.stringify({
          id: "result-2",
          timestamp: 1_780_000_003_100,
          type: "function_call_result",
          name: "Read",
          callId: "call-2",
          output: [
            { type: "text", text: "line one" },
            { type: "output_text", text: "line two" },
          ],
        }),
        JSON.stringify({
          id: "shared-response-1",
          timestamp: 1_780_000_003_200,
          type: "function_call_result",
          name: "IgnoredWithoutCallId",
          output: { type: "text", text: "ignored" },
        }),
      ].join("\n"),
    );
    fs.writeFileSync(
      subagentPath,
      JSON.stringify({
        id: "sub-user",
        timestamp: 1_780_000_004_000,
        type: "message",
        role: "user",
        content: "research the schema",
        cwd: "/repo/workbuddy",
      }),
    );
    fs.writeFileSync(ignoredPath, JSON.stringify({ type: "message", role: "user", content: "ignore me" }));
    fs.writeFileSync(invalidMainPath, JSON.stringify({ type: "message", role: "user", content: "ignore me too" }));
    fs.mkdirSync(path.dirname(invalidParentPath), { recursive: true });
    fs.writeFileSync(invalidParentPath, JSON.stringify({ type: "message", role: "user", content: "ignore me three" }));

    expect(loadDefaultSessions({ homeDir })).toHaveLength(0);
    expect(loadWorkBuddyCliSessionFile(ignoredPath)).toBeNull();
    expect(loadWorkBuddyCliSessionFile(invalidMainPath)).toBeNull();
    expect(loadWorkBuddyCliSessionFile(invalidParentPath)).toBeNull();
    const loaded = loadDefaultSessions({ homeDir, includeWorkBuddy: true });
    expect(loadWorkBuddyCliSessions(workBuddyDir)).toHaveLength(2);
    expect(loaded).toHaveLength(2);

    const main = loaded.find((session) => session.session.rawId === parentId);
    expect(main?.session).toMatchObject({
      sessionKey: `workbuddy:${parentId}`,
      source: "workbuddy-cli",
      projectPath: "/repo/workbuddy",
      originalTitle: "WorkBuddy implementation",
      firstQuestion: "code",
      timestamp: 1_780_000_000_000,
      isSubagent: false,
      parentSessionId: null,
      tokenUsage: {
        inputTokens: 1_061,
        outputTokens: 109,
        cachedInputTokens: 32_210,
        cacheCreationInputTokens: 100,
        reasoningOutputTokens: 20,
        totalTokens: 33_500,
      },
    });
    expect(main?.messages.map((message) => message.content)).toEqual(["code", "I will inspect it."]);
    expect(main?.tokenEvents?.map((event) => event.dedupeKey).sort()).toEqual([
      "workbuddy:provider-assistant-1",
      "workbuddy:provider-message-usage",
      "workbuddy:provider-tool-1",
    ]);
    expect(main?.traceEvents).toMatchObject([
      {
        kind: "tool_call",
        source: "workbuddy",
        title: "Bash · pwd",
        callId: "call-1",
        status: "running",
      },
      {
        kind: "tool_call",
        source: "workbuddy",
        title: "Read · /repo/workbuddy/README.md",
        callId: "call-2",
        status: "running",
      },
      {
        kind: "tool_result",
        source: "workbuddy",
        title: "Bash result",
        callId: "call-1",
        status: "completed",
      },
      {
        kind: "tool_result",
        source: "workbuddy",
        title: "Read result",
        callId: "call-2",
        status: "completed",
      },
    ]);
    expect(main?.traceEvents?.[1].detail).toContain("/repo/workbuddy");
    expect(main?.traceEvents?.[2].detail).toBe("/repo/workbuddy");
    expect(main?.traceEvents?.[3].detail).toBe("line one\nline two");

    const subagent = loaded.find((session) => session.session.isSubagent);
    expect(subagent?.session).toMatchObject({
      sessionKey: `workbuddy:${parentId}:subagent:2025.01.01`,
      rawId: `${parentId}:subagent:2025.01.01`,
      source: "workbuddy-cli",
      isSubagent: true,
      parentSessionId: parentId,
    });
    expect(subagent?.messages.map((message) => message.content)).toEqual(["research the schema"]);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});

describe("tclaude / tcodex optional sources", () => {
  it("indexes ~/.tclaude with the tclaude source and its own session-key namespace", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-tclaude-"));
    const projectDir = path.join(home, ".tclaude", "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "tclaude-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          sessionId: "tclaude-1",
          message: { role: "user", content: "tclaude 会话" },
        }),
      ].join("\n"),
    );

    const off = loadDefaultSessions({ homeDir: home });
    expect(off.some((item) => item.session.source === "tclaude-cli")).toBe(false);

    const loaded = loadDefaultSessions({ homeDir: home, includeTclaude: true });
    const session = loaded.find((item) => item.session.source === "tclaude-cli")?.session;
    expect(session).toMatchObject({
      sessionKey: "tclaude:tclaude-1",
      rawId: "tclaude-1",
      source: "tclaude-cli",
      projectPath: "/repo",
    });

    fs.rmSync(home, { recursive: true, force: true });
  });

  it("indexes ~/.tcodex with the tcodex source and its own session-key namespace", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-tcodex-"));
    const sessionDir = path.join(home, ".tcodex", "sessions", "2026", "06", "01");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "tcodex-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "tcodex 会话" }] },
        }),
      ].join("\n"),
    );

    const off = loadDefaultSessions({ homeDir: home });
    expect(off.some((item) => item.session.source === "tcodex-cli")).toBe(false);

    const loaded = loadDefaultSessions({ homeDir: home, includeTcodex: true });
    const session = loaded.find((item) => item.session.source === "tcodex-cli")?.session;
    expect(session).toMatchObject({
      sessionKey: "tcodex:tcodex-1",
      rawId: "tcodex-1",
      source: "tcodex-cli",
      projectPath: "/repo",
    });

    fs.rmSync(home, { recursive: true, force: true });
  });
  it("truncates an oversized Codex tool payload once instead of nesting previews", () => {
    const oversized = [
      { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "input_text", text: "SKILL detail ".repeat(TRACE_DETAIL_PREVIEW_MAX_CHARS) },
    ];
    const loaded = loadCodexSessionRows("/tmp/codex-oversized-tool-output.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-07-31T03:22:00Z",
        payload: { id: "codex-oversized-1", cwd: "/repo" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-31T03:22:24Z",
        payload: {
          type: "custom_tool_call",
          call_id: "oversized-1",
          name: "exec",
          status: "completed",
          input: "const r = await tools.exec_command({\"cmd\":\"sed -n '1,400p' SKILL.md\"});",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-31T03:22:25Z",
        payload: { type: "custom_tool_call_output", call_id: "oversized-1", output: oversized },
      },
    ]);

    const trace = loaded?.traceEvents?.find((event) => event.callId === "oversized-1");
    expect(trace).toBeDefined();
    const output = trace?.attributes?.output as { preview?: string; truncated?: boolean };
    expect(output?.truncated).toBe(true);
    expect(output?.preview).not.toContain('{"preview"');
    expect(output?.preview).not.toContain('\\\\"');
    expect(output?.preview).toContain("Wall time 0.1 seconds");
  });

  it("derives MCP tool status and duration from the recorded result", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-mcp-status.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-07-31T15:00:00Z",
        payload: { id: "codex-mcp-1", cwd: "/repo" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-31T15:00:01Z",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "mcp-ok",
          plugin_id: "mem0",
          invocation: { name: "add_memory" },
          duration: { secs: 1, nanos: 200_000_000 },
          result: { Ok: { content: [{ type: "text", text: "stored" }], isError: false } },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-31T15:00:02Z",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "mcp-bad",
          plugin_id: "mem0",
          invocation: { name: "search_memories" },
          result: { Ok: { content: [{ type: "text", text: "quota exhausted" }], isError: true } },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-31T15:00:03Z",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "mcp-err",
          plugin_id: "mem0",
          invocation: { name: "get_event_status" },
          result: { Err: "transport closed" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-31T15:00:04Z",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "mcp-bare",
          plugin_id: "mem0",
          invocation: { name: "add_memory" },
          result: { Ok: { content: [] } },
        },
      },
    ]);

    const ok = loaded?.traceEvents?.find((event) => event.callId === "mcp-ok");
    const bad = loaded?.traceEvents?.find((event) => event.callId === "mcp-bad");
    const err = loaded?.traceEvents?.find((event) => event.callId === "mcp-err");
    const bare = loaded?.traceEvents?.find((event) => event.callId === "mcp-bare");
    expect(ok?.status).toBe("completed");
    expect(ok?.attributes?.durationMs).toBe(1_200);
    expect(bad?.status).toBe("failed");
    expect(err?.status).toBe("failed");
    expect(bare?.status).toBe("unknown");
    expect(bad?.attributes?.durationMs).toBeUndefined();
  });
});
