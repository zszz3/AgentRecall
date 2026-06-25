import { describe, expect, it } from "vitest";
import {
  isLocalCliEndpoint,
  runAiAssistantFallback,
  runAiAssistantTurn,
  type AiChatMessage,
  type FallbackSessionHit,
  type SummaryEndpoint,
  type ToolChatCompletionFn,
  type ToolExecutor,
} from "./ai-assistant";

const endpoint: SummaryEndpoint = { baseUrl: "http://x", model: "m", apiKey: "k", apiFormat: "openai_chat" };
const codexEndpoint: SummaryEndpoint = { baseUrl: "", model: "codex", apiKey: "", apiFormat: "codex_exec", command: "codex" };

describe("runAiAssistantTurn", () => {
  it("executes a tool call, feeds the result back, and returns the final reply with surfaced sessionKeys", async () => {
    // Round 1: model asks to search. Round 2: model answers in plain text.
    const chatTurns: Array<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] }> = [
      { content: "", toolCalls: [{ id: "c1", name: "search_sessions", arguments: JSON.stringify({ query: "sqlite migration" }) }] },
      { content: "Found the session where you fixed the SQLite migration.", toolCalls: [] },
    ];
    const sentMessages: AiChatMessage[][] = [];
    const chat: ToolChatCompletionFn = async (_endpoint, messages) => {
      sentMessages.push(messages);
      return chatTurns.shift()!;
    };

    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    const executeTool: ToolExecutor = async (name, args) => {
      executed.push({ name, args });
      return {
        result: [{ sessionKey: "sess-42", title: "Fix migration" }],
        sessionKeys: ["sess-42"],
      };
    };

    const result = await runAiAssistantTurn(endpoint, [{ role: "user", content: "find my sqlite migration fix" }], executeTool, {
      chat,
    });

    expect(executed).toEqual([{ name: "search_sessions", args: { query: "sqlite migration" } }]);
    expect(result.reply).toBe("Found the session where you fixed the SQLite migration.");
    expect(result.sessionKeys).toEqual(["sess-42"]);
    // The second LLM call must include the tool result so the model can answer.
    const secondCall = sentMessages[1];
    expect(secondCall.some((m) => m.role === "tool" && m.content.includes("sess-42"))).toBe(true);
  });

  it("dedupes sessionKeys surfaced across multiple tool calls", async () => {
    const chatTurns: Array<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] }> = [
      {
        content: "",
        toolCalls: [
          { id: "a", name: "search_sessions", arguments: JSON.stringify({ query: "auth" }) },
          { id: "b", name: "get_session", arguments: JSON.stringify({ sessionKey: "dup" }) },
        ],
      },
      { content: "done", toolCalls: [] },
    ];
    const chat: ToolChatCompletionFn = async () => chatTurns.shift()!;
    const executeTool: ToolExecutor = async (name) => ({
      result: {},
      sessionKeys: name === "search_sessions" ? ["dup", "other"] : ["dup"],
    });

    const result = await runAiAssistantTurn(endpoint, [{ role: "user", content: "x" }], executeTool, { chat });
    expect(result.sessionKeys).toEqual(["dup", "other"]);
  });

  it("captures a tool execution error and still completes", async () => {
    const chatTurns: Array<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] }> = [
      { content: "", toolCalls: [{ id: "c1", name: "search_sessions", arguments: "{}" }] },
      { content: "I hit an error but here is what I can say.", toolCalls: [] },
    ];
    const captured: AiChatMessage[][] = [];
    const chat: ToolChatCompletionFn = async (_e, messages) => {
      captured.push(messages);
      return chatTurns.shift()!;
    };
    const executeTool: ToolExecutor = async () => {
      throw new Error("db is locked");
    };

    const result = await runAiAssistantTurn(endpoint, [{ role: "user", content: "x" }], executeTool, { chat });
    expect(result.reply).toBe("I hit an error but here is what I can say.");
    const toolMsg = captured[1].find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("db is locked");
  });
});

describe("isLocalCliEndpoint", () => {
  it("flags codex_exec and claude_exec, not HTTP formats", () => {
    expect(isLocalCliEndpoint(codexEndpoint)).toBe(true);
    expect(isLocalCliEndpoint({ ...codexEndpoint, apiFormat: "claude_exec" })).toBe(true);
    expect(isLocalCliEndpoint(endpoint)).toBe(false);
    expect(isLocalCliEndpoint({ ...endpoint, apiFormat: "anthropic" })).toBe(false);
  });
});

describe("runAiAssistantFallback", () => {
  it("searches with the user's words and asks the CLI to ground its answer over the hits", async () => {
    const hits: FallbackSessionHit[] = [
      { sessionKey: "s1", title: "Fix SQLite migration", source: "claude-cli", project: "/p", summary: "fixed it" },
      { sessionKey: "s2", title: "Other", source: "codex-cli", project: "/q", summary: null },
    ];
    let searchedQuery = "";
    const search = async (query: string): Promise<FallbackSessionHit[]> => {
      searchedQuery = query;
      return hits;
    };
    let promptSeen = "";
    const complete = async (_e: SummaryEndpoint, messages: { role: string; content: string }[]) => {
      promptSeen = messages.map((m) => m.content).join("\n");
      return "The first session matches best.";
    };

    const history: AiChatMessage[] = [{ role: "user", content: "find my sqlite migration fix" }];
    const result = await runAiAssistantFallback(codexEndpoint, history, search, { complete });

    expect(searchedQuery).toBe("find my sqlite migration fix");
    expect(result.reply).toBe("The first session matches best.");
    expect(result.sessionKeys).toEqual(["s1", "s2"]);
    // The CLI prompt must include the candidate catalog so the answer is grounded.
    expect(promptSeen).toContain("Fix SQLite migration");
    expect(promptSeen).toContain("[1]");
  });

  it("tells the CLI when nothing matched", async () => {
    const search = async (): Promise<FallbackSessionHit[]> => [];
    let promptSeen = "";
    const complete = async (_e: SummaryEndpoint, messages: { role: string; content: string }[]) => {
      promptSeen = messages.map((m) => m.content).join("\n");
      return "No matching sessions; try other keywords.";
    };

    const result = await runAiAssistantFallback(
      codexEndpoint,
      [{ role: "user", content: "nonexistent topic" }],
      search,
      { complete },
    );

    expect(result.sessionKeys).toEqual([]);
    expect(promptSeen).toContain("No sessions matched");
  });
});
