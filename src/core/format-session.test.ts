import { describe, expect, it } from "vitest";
import { formatSessionJson, formatSessionMarkdown, formatSessionPlainText } from "./format-session";
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

const traceEvents: SessionTraceEvent[] = [
  {
    index: 0,
    kind: "tool_call",
    source: "codex",
    title: "shell_command · npm test",
    detail: '{\n  "command": "npm test"\n}',
    timestamp: "2026-06-01T10:02:00Z",
    callId: "call-1",
  },
  {
    index: 1,
    kind: "event",
    source: "codex",
    eventType: "exec_command_end",
    title: "shell · npm test",
    detail: "stdout:\npass",
    timestamp: "2026-06-01T10:03:00Z",
    callId: "call-1",
    status: "success",
  },
];

describe("formatSessionMarkdown", () => {
  it("omits trace events by default", () => {
    expect(formatSessionMarkdown(session, messages)).not.toContain("Tool Trace");
  });

  it("includes trace events when provided", () => {
    const markdown = formatSessionMarkdown(session, messages, traceEvents);

    expect(markdown).toContain("## Tool Trace");
    expect(markdown).toContain("shell_command · npm test");
    expect(markdown).toContain("shell · npm test");
    expect(markdown).toContain("stdout:");
  });

  it("uses the shared source label for Qoder exports", () => {
    expect(formatSessionMarkdown({ ...session, source: "qoder" }, messages)).toContain("Qoder · `/repo`");
  });
});

describe("formatSessionPlainText", () => {
  it("includes trace events when provided", () => {
    const text = formatSessionPlainText(session, messages, traceEvents);

    expect(text).toContain("Tool Trace");
    expect(text).toContain("shell_command · npm test");
    expect(text).toContain("stdout:");
  });
});

describe("formatSessionJson", () => {
  it("exports an OpenAI Chat Completions request body", () => {
    expect(JSON.parse(formatSessionJson(messages, "openai_chat"))).toEqual({
      model: "YOUR_MODEL",
      messages: [
        { role: "user", content: "run tests" },
        { role: "assistant", content: "I will run them." },
      ],
      stream: false,
    });
  });

  it("exports an OpenAI Responses request body", () => {
    expect(JSON.parse(formatSessionJson(messages, "openai_responses"))).toEqual({
      model: "YOUR_MODEL",
      input: [
        { role: "user", content: "run tests" },
        { role: "assistant", content: "I will run them." },
      ],
      stream: false,
    });
  });

  it("exports an Anthropic Messages request body with max_tokens", () => {
    expect(JSON.parse(formatSessionJson(messages, "anthropic"))).toEqual({
      model: "YOUR_MODEL",
      max_tokens: 4096,
      messages: [
        { role: "user", content: "run tests" },
        { role: "assistant", content: "I will run them." },
      ],
      stream: false,
    });
  });

  it("preserves a captured Codex Responses request without normalizing it", () => {
    const request = {
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      stream: true,
      metadata: { trace: "kept" },
    };

    expect(JSON.parse(formatSessionJson(messages, "openai_responses", request))).toEqual(request);
  });

  it("converts Responses tools and tool calls to Chat Completions", () => {
    const request = {
      model: "gpt-5.4",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Find it" }] },
        { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{\"id\":\"42\"}" },
        { type: "function_call_output", call_id: "call-1", output: "found" },
      ],
      tools: [{ type: "function", name: "lookup", description: "Look it up", parameters: { type: "object" } }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      stream: true,
    };

    expect(JSON.parse(formatSessionJson(messages, "openai_chat", request))).toEqual({
      model: "gpt-5.4",
      messages: [
        { role: "user", content: "Find it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"id\":\"42\"}" } }] },
        { role: "tool", tool_call_id: "call-1", content: "found" },
      ],
      stream: true,
      tools: [{ type: "function", function: { name: "lookup", description: "Look it up", parameters: { type: "object" } } }],
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
  });

  it("converts Responses instructions and tool calls to Anthropic Messages", () => {
    const request = {
      model: "claude-sonnet-4-5",
      instructions: "Be concise.",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "Use tools." }] },
        { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{\"id\":\"42\"}" },
        { type: "function_call_output", call_id: "call-1", output: "found" },
      ],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      stream: true,
    };

    expect(JSON.parse(formatSessionJson(messages, "anthropic", request))).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { id: "42" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "found" }] },
      ],
      stream: true,
      system: "Be concise.\n\nUse tools.",
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
    });
  });

  it("preserves instructions and groups parallel namespaced tools in Chat Completions", () => {
    const request = {
      model: "gpt-5.4",
      instructions: "Follow repository rules.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect both" }] },
        { type: "function_call", namespace: "files/tools", call_id: "call-1", name: "read", arguments: "{\"path\":\"a.ts\"}" },
        { type: "custom_tool_call", call_id: "call-2", name: "python", input: "print(1)" },
        { type: "function_call_output", call_id: "call-1", output: { text: "source" } },
        { type: "custom_tool_call_output", call_id: "call-2", output: ["line 1", "line 2"] },
      ],
      tools: [
        { type: "namespace", name: "files/tools", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
        { type: "custom", name: "python", description: "Run Python" },
      ],
      stream: true,
    };

    expect(JSON.parse(formatSessionJson(messages, "openai_chat", request))).toEqual({
      model: "gpt-5.4",
      messages: [
        { role: "developer", content: "Follow repository rules." },
        { role: "user", content: "Inspect both" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "files__tools__read", arguments: "{\"path\":\"a.ts\"}" } },
            { id: "call-2", type: "function", function: { name: "python", arguments: "{\"input\":\"print(1)\"}" } },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "{\"text\":\"source\"}" },
        { role: "tool", tool_call_id: "call-2", content: "[\"line 1\",\"line 2\"]" },
      ],
      stream: true,
      tools: [
        { type: "function", function: { name: "files__tools__read", parameters: { type: "object" } } },
        {
          type: "function",
          function: {
            name: "python",
            description: "Run Python",
            parameters: {
              type: "object",
              properties: { input: { type: "string" } },
              required: ["input"],
              additionalProperties: false,
            },
          },
        },
      ],
    });
  });

  it("groups parallel Anthropic tool blocks and preserves structured result content", () => {
    const request = {
      model: "claude-sonnet-4-5",
      input: [
        { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{\"id\":1}" },
        { type: "custom_tool_call", call_id: "call-2", name: "python", input: "print(1)" },
        { type: "function_call_output", call_id: "call-1", output: { found: true } },
        { type: "custom_tool_call_output", call_id: "call-2", output: { content: [{ type: "output_text", text: "1" }] } },
      ],
      tools: [
        { type: "function", name: "lookup", parameters: { type: "object" } },
        { type: "custom", name: "python" },
      ],
    };

    expect(JSON.parse(formatSessionJson(messages, "anthropic", request))).toMatchObject({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-1", name: "lookup", input: { id: 1 } },
            { type: "tool_use", id: "call-2", name: "python", input: { input: "print(1)" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "{\"found\":true}" },
            { type: "tool_result", tool_use_id: "call-2", content: [{ type: "text", text: "1" }] },
          ],
        },
      ],
      tools: [
        { name: "lookup", input_schema: { type: "object" } },
        {
          name: "python",
          input_schema: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      ],
    });
  });
});
