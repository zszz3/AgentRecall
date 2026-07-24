import { describe, expect, test } from "vitest";
import { createClaudeStreamState, normalizeClaudeStreamEvent } from "./claude-stream";

describe("normalizeClaudeStreamEvent", () => {
  test("extracts assistant text from Claude stream-json messages", () => {
    const events = normalizeClaudeStreamEvent({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello from Claude" }],
      },
    });

    expect(events).toEqual([{ type: "delta", content: "Hello from Claude" }]);
  });

  test("extracts result session id and completion", () => {
    const events = normalizeClaudeStreamEvent({
      type: "result",
      subtype: "success",
      session_id: "session-123",
      result: "Final answer",
    });

    expect(events).toEqual([
      {
        type: "runtime_conversation",
        runtimeConversation: {
          runtimeId: "claude",
          codecVersion: "v1",
          payload: { native: { sessionId: "session-123" } },
        },
      },
      { type: "completed", content: "Final answer" },
    ]);
  });

  test("normalizes Anthropic result usage including cache tiers", () => {
    const events = normalizeClaudeStreamEvent({
      type: "result",
      result: "Final answer",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 60,
        cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 20 },
      },
      modelUsage: { "claude-sonnet": { costUSD: 0.123 } },
    });

    expect(events[0]).toEqual({
      type: "usage",
      usage: {
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheWriteInputTokens: 60,
        cacheWrite5mInputTokens: 40,
        cacheWrite1hInputTokens: 20,
        estimatedCost: 0.123,
      },
    });
  });

  test("emits only new text when Claude partial messages are snapshots", () => {
    const state = createClaudeStreamState();

    expect(
      normalizeClaudeStreamEvent(
        { type: "assistant", message: { content: [{ type: "text", text: "Hel" }] } },
        state,
      ),
    ).toEqual([{ type: "delta", content: "Hel" }]);
    expect(
      normalizeClaudeStreamEvent(
        { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
        state,
      ),
    ).toEqual([{ type: "delta", content: "lo" }]);
  });

  test("streams token deltas from partial message stream events", () => {
    const state = createClaudeStreamState();

    expect(
      normalizeClaudeStreamEvent(
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
        state,
      ),
    ).toEqual([{ type: "delta", content: "Hel" }]);
    expect(
      normalizeClaudeStreamEvent(
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
        state,
      ),
    ).toEqual([{ type: "delta", content: "lo" }]);
    expect(
      normalizeClaudeStreamEvent(
        { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
        state,
      ),
    ).toEqual([]);
  });

  test("does not duplicate result text after assistant text already streamed", () => {
    const state = createClaudeStreamState();

    normalizeClaudeStreamEvent({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }, state);

    expect(
      normalizeClaudeStreamEvent(
        { type: "result", subtype: "success", session_id: "session-123", result: "Hello" },
        state,
      ),
    ).toEqual([
      {
        type: "runtime_conversation",
        runtimeConversation: {
          runtimeId: "claude",
          codecVersion: "v1",
          payload: { native: { sessionId: "session-123" } },
        },
      },
      { type: "completed" },
    ]);
  });

  test("pairs Claude tool results with tool uses by id", () => {
    const state = createClaudeStreamState();

    expect(
      normalizeClaudeStreamEvent(
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "src/App.tsx" } },
              { type: "mcp_tool_use", id: "toolu_2", name: "mcp__multi_agent_chat__workflow_create", input: { title: "Plan" } },
            ],
          },
        },
        state,
      ),
    ).toEqual([
      {
        type: "tool_call",
        name: "Read",
        content: '{\n  "file_path": "src/App.tsx"\n}',
        metadata: { id: "toolu_1" },
      },
      {
        type: "tool_call",
        name: "mcp__multi_agent_chat__workflow_create",
        content: '{\n  "title": "Plan"\n}',
        metadata: { id: "toolu_2" },
      },
    ]);

    expect(
      normalizeClaudeStreamEvent(
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "Workflow created" }],
          },
        },
        state,
      ),
    ).toEqual([
      { type: "tool_result", name: "mcp__multi_agent_chat__workflow_create", content: "Workflow created", metadata: { id: "toolu_2" } },
    ]);

    expect(normalizeClaudeStreamEvent({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "mcp_tool_result", tool_use_id: "toolu_2", content: "Permission rejected", is_error: true }],
      },
    }, state)).toEqual([{
      type: "tool_result",
      name: "mcp__multi_agent_chat__workflow_create",
      content: "Permission rejected",
      metadata: { id: "toolu_2", status: "failed" },
    }]);

    expect(
      normalizeClaudeStreamEvent(
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "App.tsx" }] }],
          },
        },
        state,
      ),
    ).toEqual([{ type: "tool_result", name: "Read", content: "App.tsx", metadata: { id: "toolu_1" } }]);
  });
});
