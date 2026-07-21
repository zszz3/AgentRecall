import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../../../shared/types";
import { ClaudeAgentSdkInteractive } from "./claude-agent-sdk-interactive";

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

class FakeQuery implements AsyncIterator<unknown> {
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(() => {
    this.output.close();
  });
  readonly output = new AsyncMessageQueue<unknown>();

  async next(): Promise<IteratorResult<unknown>> {
    return this.output[Symbol.asyncIterator]().next();
  }

  async return(): Promise<IteratorResult<unknown>> {
    this.output.close();
    return { value: undefined, done: true };
  }

  async throw(error?: unknown): Promise<IteratorResult<unknown>> {
    throw error;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ClaudeAgentSdkInteractive", () => {
  test("initial attach starts SDK query with a streaming input prompt and mapped options", async () => {
    const fakeQuery = new FakeQuery();
    const queryImpl = vi.fn((_input: { prompt: AsyncIterable<SDKUserMessage>; options?: Record<string, unknown> }) => {
      return fakeQuery as unknown as Query;
    });

    const interactive = new ClaudeAgentSdkInteractive({ queryImpl: queryImpl as never });
    await interactive.attach({
      cwd: "C:/repo",
      modelId: "claude-sonnet",
      developerInstructions: "Be precise.",
      mcpServers: { multi_agent_chat: { type: "stdio", command: "node", args: ["mcp-server.js"] } },
      onEvent: () => undefined,
    });

    expect(interactive.isAttached()).toBe(true);
    expect(queryImpl).toHaveBeenCalledTimes(1);
    const call = queryImpl.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call?.options).toMatchObject({
      cwd: "C:/repo",
      model: "claude-sonnet",
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Be precise.",
      },
      permissionMode: "default",
      mcpServers: { multi_agent_chat: { type: "stdio", command: "node", args: ["mcp-server.js"] } },
    });
    expect(typeof call?.prompt?.[Symbol.asyncIterator]).toBe("function");
    expect(typeof call?.options?.canUseTool).toBe("function");
    expect(typeof call?.options?.onElicitation).toBe("function");
  });

  test("sendUserMessage pushes multiple messages through the same streaming input", async () => {
    const fakeQuery = new FakeQuery();
    const streamedMessages: SDKUserMessage[] = [];
    const queryImpl = vi.fn((input: { prompt: AsyncIterable<SDKUserMessage> }) => {
      void (async () => {
        for await (const message of input.prompt) {
          streamedMessages.push(message);
          if (streamedMessages.length >= 2) break;
        }
      })();
      return fakeQuery as unknown as Query;
    });

    const interactive = new ClaudeAgentSdkInteractive({ queryImpl: queryImpl as never });
    await interactive.attach({
      cwd: "C:/repo",
      onEvent: () => undefined,
    });

    await interactive.sendUserMessage("first");
    await interactive.sendUserMessage("second");
    await flushAsyncWork();

    expect(queryImpl).toHaveBeenCalledTimes(1);
    expect(streamedMessages).toEqual([
      {
        type: "user",
        message: { role: "user", content: "first" },
        parent_tool_use_id: null,
      },
      {
        type: "user",
        message: { role: "user", content: "second" },
        parent_tool_use_id: null,
      },
    ]);
  });

  test("detach then reattach passes resumeSessionId to SDK query options", async () => {
    const queryImpl = vi.fn((_input: { prompt: AsyncIterable<SDKUserMessage>; options?: Record<string, unknown> }) => {
      return new FakeQuery() as unknown as Query;
    });

    const interactive = new ClaudeAgentSdkInteractive({ queryImpl: queryImpl as never });
    await interactive.attach({
      cwd: "C:/repo",
      onEvent: () => undefined,
    });
    await interactive.detach();
    await interactive.attach({
      cwd: "C:/repo",
      resumeSessionId: "claude-session-1",
      onEvent: () => undefined,
    });

    expect(queryImpl).toHaveBeenCalledTimes(2);
    expect(queryImpl.mock.calls[0]?.[0]?.options).not.toHaveProperty("resume");
    expect(queryImpl.mock.calls[1]?.[0]?.options).toMatchObject({
      resume: "claude-session-1",
    });
  });

  test("interrupt forwards to the active SDK query", async () => {
    const fakeQuery = new FakeQuery();
    const interactive = new ClaudeAgentSdkInteractive({
      queryImpl: vi.fn(() => fakeQuery as unknown as Query) as never,
    });

    await interactive.attach({
      cwd: "C:/repo",
      onEvent: () => undefined,
    });
    await interactive.interrupt();

    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);
  });

  test("detach closes the query and clears attached state", async () => {
    const fakeQuery = new FakeQuery();
    const interactive = new ClaudeAgentSdkInteractive({
      queryImpl: vi.fn(() => fakeQuery as unknown as Query) as never,
    });

    await interactive.attach({
      cwd: "C:/repo",
      onEvent: () => undefined,
    });
    await interactive.detach();

    expect(fakeQuery.close).toHaveBeenCalledTimes(1);
    expect(interactive.isAttached()).toBe(false);
  });

  test("normalizes SDK messages into shared AgentEvent values", async () => {
    const fakeQuery = new FakeQuery();
    const events: AgentEvent[] = [];
    const interactive = new ClaudeAgentSdkInteractive({
      queryImpl: vi.fn(() => fakeQuery as unknown as Query) as never,
    });

    await interactive.attach({
      cwd: "C:/repo",
      onEvent: (event) => events.push(event),
    });

    fakeQuery.output.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hel" }] },
    });
    fakeQuery.output.push({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "lo" },
      },
    });
    fakeQuery.output.push({
      type: "result",
      subtype: "success",
      session_id: "claude-session-1",
      result: "Hello",
    });
    fakeQuery.output.close();
    await flushAsyncWork();

    expect(events).toEqual([
      { type: "delta", content: "Hel" },
      { type: "delta", content: "lo" },
      {
        type: "runtime_conversation",
        runtimeConversation: {
          runtimeId: "claude",
          codecVersion: "v1",
          payload: { native: { sessionId: "claude-session-1" } },
        },
      },
      { type: "completed" },
    ]);
  });
});
