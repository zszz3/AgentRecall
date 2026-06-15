import { describe, expect, it } from "vitest";
import {
  buildSummaryMessages,
  needsBackfill,
  parseSummaryResponse,
  resolveSummaryEndpoint,
  type SummaryProviderConfig,
  summarizeSession,
  summaryFreshness,
} from "./session-summarizer";

function customConfig(overrides: Partial<SummaryProviderConfig>): SummaryProviderConfig {
  return {
    activeProvider: "custom",
    customBaseUrl: "https://api.deepseek.com",
    customApiKey: "sk-test",
    customModel: "deepseek-v4-flash",
    customApiFormat: "openai_chat",
    ...overrides,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe("resolveSummaryEndpoint", () => {
  it("prefers the first usable custom config and trims trailing slashes", () => {
    const endpoint = resolveSummaryEndpoint([customConfig({ customBaseUrl: "https://a.com/v1/" }), customConfig({})]);
    expect(endpoint).toEqual({ baseUrl: "https://a.com/v1", model: "deepseek-v4-flash", apiKey: "sk-test", apiFormat: "openai_chat" });
  });

  it("falls back to the next config when the first is unconfigured", () => {
    const dedicated = customConfig({ customApiKey: "" });
    const fallback = customConfig({ customModel: "kimi-k2.6", customApiKey: "sk-fallback" });
    expect(resolveSummaryEndpoint([dedicated, fallback])?.model).toBe("kimi-k2.6");
  });

  it("skips official providers and returns null when nothing is usable", () => {
    expect(resolveSummaryEndpoint([customConfig({ activeProvider: "official" })])).toBeNull();
  });

  it("maps an anthropic config (e.g. a coding-plan provider) to the anthropic format", () => {
    const endpoint = resolveSummaryEndpoint([
      customConfig({ activeProvider: "official" }),
      customConfig({ customBaseUrl: "https://open.bigmodel.cn/api/anthropic", customModel: "glm-5.1", customApiFormat: "anthropic" }),
    ]);
    expect(endpoint?.apiFormat).toBe("anthropic");
    expect(endpoint?.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
  });

  it("infers anthropic from an /anthropic base URL even when the format says openai_chat", () => {
    const endpoint = resolveSummaryEndpoint([
      customConfig({ customBaseUrl: "https://open.bigmodel.cn/api/anthropic", customModel: "glm-5.1", customApiFormat: "openai_chat" }),
    ]);
    expect(endpoint?.apiFormat).toBe("anthropic");
  });
});

describe("parseSummaryResponse", () => {
  it("parses a clean JSON object", () => {
    const result = parseSummaryResponse('{"summary":"Fixed a quota bug.","title":"Quota fix","tags":["bug","quota"]}');
    expect(result).toEqual({ summary: "Fixed a quota bug.", title: "Quota fix", tags: ["bug", "quota"] });
  });

  it("extracts JSON wrapped in prose / code fences and normalizes tags", () => {
    const reply = "Here you go:\n```json\n{\"summary\":\"Did X.\",\"title\":\"X\",\"tags\":[\"Node JS\",\"node js\",\"\"]}\n```";
    const result = parseSummaryResponse(reply);
    expect(result.summary).toBe("Did X.");
    expect(result.tags).toEqual(["node-js"]);
  });

  it("throws when summary is missing", () => {
    expect(() => parseSummaryResponse('{"title":"x","tags":[]}')).toThrow();
    expect(() => parseSummaryResponse("not json")).toThrow();
  });
});

describe("buildSummaryMessages", () => {
  it("includes only user/assistant content in the transcript", () => {
    const messages = buildSummaryMessages({
      head: [
        { role: "user", content: "how do I fix this" },
        { role: "tool", content: "noise" },
        { role: "assistant", content: "do this" },
      ],
      tail: [],
      omittedCount: 0,
    });
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("USER: how do I fix this");
    expect(messages[1].content).toContain("ASSISTANT: do this");
    expect(messages[1].content).not.toContain("noise");
  });

  it("joins head and tail with an omitted marker for long sessions", () => {
    const messages = buildSummaryMessages({
      head: [{ role: "user", content: "the original problem" }],
      tail: [{ role: "assistant", content: "the final fix" }],
      omittedCount: 120,
    });
    const transcript = messages[1].content;
    expect(transcript).toContain("USER: the original problem");
    expect(transcript).toContain("[... 120 messages omitted ...]");
    expect(transcript).toContain("ASSISTANT: the final fix");
    expect(transcript.indexOf("original problem")).toBeLessThan(transcript.indexOf("final fix"));
  });
});

describe("summarizeSession", () => {
  it("calls the chat fn and parses its reply", async () => {
    const result = await summarizeSession(
      { head: [{ role: "user", content: "fix the build" }], tail: [], omittedCount: 0 },
      { baseUrl: "https://x", model: "m", apiKey: "k", apiFormat: "openai_chat" },
      async () => '{"summary":"Fixed the build.","title":"Build fix","tags":["ci"]}',
    );
    expect(result.summary).toBe("Fixed the build.");
  });

  it("throws before calling the model when there is nothing to summarize", async () => {
    let called = false;
    await expect(
      summarizeSession({ head: [{ role: "tool", content: "only tool output" }], tail: [], omittedCount: 0 }, { baseUrl: "x", model: "m", apiKey: "k", apiFormat: "openai_chat" }, async () => {
        called = true;
        return "{}";
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe("summaryFreshness / needsBackfill", () => {
  it("classifies missing, stale, and fresh", () => {
    expect(summaryFreshness({ updatedAt: 100 }, null)).toBe("missing");
    expect(summaryFreshness({ updatedAt: 200 }, { basisUpdatedAt: 100 })).toBe("stale");
    expect(summaryFreshness({ updatedAt: 100 }, { basisUpdatedAt: 100 })).toBe("fresh");
  });

  it("backfills missing/stale sessions within the age window", () => {
    const now = 100 * DAY;
    expect(needsBackfill({ updatedAt: now - DAY }, null, now, 30 * DAY)).toBe(true);
    expect(needsBackfill({ updatedAt: now - DAY }, { basisUpdatedAt: now - 2 * DAY }, now, 30 * DAY)).toBe(true);
  });

  it("skips fresh sessions and sessions older than the age window", () => {
    const now = 100 * DAY;
    expect(needsBackfill({ updatedAt: now - DAY }, { basisUpdatedAt: now - DAY }, now, 30 * DAY)).toBe(false);
    expect(needsBackfill({ updatedAt: now - 40 * DAY }, null, now, 30 * DAY)).toBe(false);
  });
});
