import { describe, expect, it } from "vitest";
import {
  anthropicRequestToOpenAiChat,
  anthropicResponseToOpenAiChat,
  openAiChatRequestToAnthropic,
  openAiChatResponseToAnthropic,
  translateRequestBody,
} from "./gateway-protocol";

describe("gateway-protocol", () => {
  it("translates Anthropic Messages requests with tools into OpenAI Chat Completions", () => {
    const out = anthropicRequestToOpenAiChat({
      model: "claude-sonnet-4-6",
      system: "Be concise.",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Run tests" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "npm test" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      ],
      tools: [{ name: "bash", description: "Run shell", input_schema: { type: "object" } }],
    }, "deepseek-chat");

    expect(out.model).toBe("deepseek-chat");
    expect(out.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Run tests" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "toolu_1", type: "function", function: { name: "bash", arguments: '{"cmd":"npm test"}' } }],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "ok" },
    ]);
    expect(out.tools).toHaveLength(1);
  });

  it("translates OpenAI Chat responses back into Anthropic Messages with token telemetry", () => {
    const { body, telemetry } = openAiChatResponseToAnthropic({
      id: "chatcmpl_1",
      model: "deepseek-chat",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "All checks passed." },
      }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 700 },
      },
    }, "deepseek-chat");

    expect(body.stop_reason).toBe("end_turn");
    expect(body.content).toEqual([{ type: "text", text: "All checks passed." }]);
    expect(telemetry).toMatchObject({
      inputTokens: 300,
      cachedInputTokens: 700,
      outputTokens: 80,
      hasToolCall: false,
      replyPreview: "All checks passed.",
    });
  });

  it("translates OpenAI Chat requests into Anthropic Messages and back", () => {
    const req = openAiChatRequestToAnthropic({
      model: "gpt-5",
      messages: [
        { role: "system", content: "You are a reviewer." },
        { role: "user", content: "Check diff." },
      ],
    }, "claude-sonnet-4-6");
    expect(req.system).toBe("You are a reviewer.");
    expect(req.model).toBe("claude-sonnet-4-6");

    const { body, telemetry } = anthropicResponseToOpenAiChat({
      id: "msg_1",
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Looks good." }],
      usage: { input_tokens: 120, cache_read_input_tokens: 40, output_tokens: 20 },
    }, "claude-sonnet-4-6");
    expect((body.choices as Array<{ finish_reason: string }>)[0]?.finish_reason).toBe("stop");
    expect(telemetry.replyPreview).toBe("Looks good.");
  });

  it("pivots OpenAI Responses requests into OpenAI Chat when upstream uses chat completions", () => {
    const translated = translateRequestBody("openai_responses", "openai_chat", {
      instructions: "System rules",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }],
      stream: false,
    }, "deepseek-v4");
    expect(translated.pathSuffix).toBe("/chat/completions");
    expect(translated.body.model).toBe("deepseek-v4");
  });
});
