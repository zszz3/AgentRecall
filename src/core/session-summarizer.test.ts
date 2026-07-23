import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSummaryMessages,
  needsBackfill,
  parseSummaryResponse,
  quoteWindowsArg,
  requestSummaryCompletion,
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
const temporaryExecutableDirectories = new Set<string>();

afterAll(async () => {
  await Promise.all([...temporaryExecutableDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeCodexExecFake(): Promise<{ executable: string; callsPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-summary-codex-"));
  temporaryExecutableDirectories.add(dir);
  const executable = path.join(dir, "codex-fake");
  const callsPath = path.join(dir, "calls.jsonl");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const callsPath = ${JSON.stringify(callsPath)};

fs.appendFileSync(callsPath, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
if (!process.argv.includes("exec") || !process.argv.includes("--ephemeral") || !process.argv.includes("--json")) {
  console.error("expected codex exec --ephemeral --json");
  process.exit(2);
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

write({ type: "thread.started", thread_id: "thread-summary-1" });
write({ type: "turn.started" });
write({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: "{\\"summary\\":\\"Summarized with current Codex config.\\",\\"title\\":\\"Codex summary\\",\\"tags\\":[\\"summary\\"]}" } });
write({ type: "turn.completed" });
`;
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  return { executable, callsPath };
}

async function writeCodexExecTerminatingFake(): Promise<{ executable: string; callsPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-summary-codex-term-"));
  temporaryExecutableDirectories.add(dir);
  const executable = path.join(dir, "codex-fake");
  const callsPath = path.join(dir, "calls.jsonl");
  // Emits the thread start then kills itself with SIGTERM, mimicking an aborted/timed-out
  // run where the process exits via signal (exit code null).
  const script = `#!/usr/bin/env node
const fs = require("fs");
const callsPath = ${JSON.stringify(callsPath)};
fs.appendFileSync(callsPath, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-summary-term" }) + "\\n");
process.kill(process.pid, "SIGTERM");
setTimeout(() => process.exit(0), 1000);
`;
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  return { executable, callsPath };
}

async function writeClaudeExecFake(): Promise<{ executable: string; callsPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-summary-claude-"));
  temporaryExecutableDirectories.add(dir);
  const executable = path.join(dir, "claude-fake");
  const callsPath = path.join(dir, "calls.jsonl");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const callsPath = ${JSON.stringify(callsPath)};

fs.appendFileSync(callsPath, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
if (!process.argv.includes("--print") || !process.argv.includes("stream-json")) {
  console.error("expected claude --print --output-format stream-json");
  process.exit(2);
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

write({ type: "system", session_id: "claude-summary-1" });
write({ type: "result", subtype: "success", session_id: "claude-summary-1", result: "{\\"summary\\":\\"Summarized with current Claude Code settings.\\",\\"title\\":\\"Claude summary\\",\\"tags\\":[\\"summary\\"]}" });
`;
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  return { executable, callsPath };
}

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

  it("returns null when no provider has a complete custom endpoint", () => {
    expect(resolveSummaryEndpoint([customConfig({ activeProvider: "official", customApiKey: "" })])).toBeNull();
  });

  it("ignores saved custom endpoint fields when that provider is not currently active", () => {
    const endpoint = resolveSummaryEndpoint([
      customConfig({ activeProvider: "official", customBaseUrl: "https://api.codexzh.com/v1", customModel: "gpt-5.5", customApiFormat: "openai_responses" }),
    ]);
    expect(endpoint).toBeNull();
  });

  it("maps an anthropic config (e.g. a coding-plan provider) to the anthropic format", () => {
    const endpoint = resolveSummaryEndpoint([
      customConfig({ customApiKey: "" }),
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

  it("preserves OpenAI Responses configs when falling back to the Codex provider", () => {
    const endpoint = resolveSummaryEndpoint([
      customConfig({ customApiKey: "" }),
      customConfig({ customBaseUrl: "https://api.codexzh.com/v1", customModel: "gpt-5.5", customApiFormat: "openai_responses" }),
    ]);
    expect(endpoint).toEqual({ baseUrl: "https://api.codexzh.com/v1", model: "gpt-5.5", apiKey: "sk-test", apiFormat: "openai_responses" });
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

  it("calls OpenAI Responses API endpoints and parses output_text replies", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ output_text: '{"summary":"Fixed fallback summaries.","title":"Fallback fix","tags":["summary"]}' }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await summarizeSession(
        { head: [{ role: "user", content: "fallback summarize fails in codex" }], tail: [], omittedCount: 0 },
        { baseUrl: "https://api.codexzh.com/v1", model: "gpt-5.5", apiKey: "sk-test", apiFormat: "openai_responses" },
        requestSummaryCompletion,
      );

      expect(result.summary).toBe("Fixed fallback summaries.");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.codexzh.com/v1/responses");
      expect(calls[0].body).toMatchObject({
        model: "gpt-5.5",
        instructions: expect.stringContaining("You label developer AI-coding sessions"),
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: expect.stringContaining("fallback summarize fails in codex") }] },
        ],
        temperature: 0.2,
        stream: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries without temperature when the model rejects it (HTTP 400 deprecated)", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push(body);
      if ("temperature" in body) {
        return new Response(JSON.stringify({ message: "`temperature` is deprecated for this model." }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"summary":"Summarized without temperature.","title":"Ok","tags":["summary"]}' } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await summarizeSession(
        { head: [{ role: "user", content: "summarize with a temperature-less model" }], tail: [], omittedCount: 0 },
        { baseUrl: "https://api.example/v1", model: "gpt-5.5", apiKey: "sk-test", apiFormat: "openai_chat" },
        requestSummaryCompletion,
      );

      expect(result.summary).toBe("Summarized without temperature.");
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty("temperature", 0.2);
      expect(bodies[1]).not.toHaveProperty("temperature");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the current Codex config through codex_exec and records the temporary session", async () => {
    const fake = await writeCodexExecFake();
    const temporarySessions: string[] = [];

    const result = await summarizeSession(
      { head: [{ role: "user", content: "summarize using official codex" }], tail: [], omittedCount: 0 },
      {
        baseUrl: "",
        model: "codex",
        apiKey: "",
        apiFormat: "codex_exec",
        command: fake.executable,
        cwd: path.dirname(fake.executable),
        onTemporarySession: (sessionKey) => temporarySessions.push(sessionKey),
      },
      requestSummaryCompletion,
    );

    const calls = (await readFile(fake.callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(result.summary).toBe("Summarized with current Codex config.");
    expect(temporarySessions).toEqual(["codex:thread-summary-1"]);
    expect(calls[0].args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--json", "--skip-git-repo-check"]));
  });

  it("does not fall back to claude when the codex run is terminated by a signal", async () => {
    const codexFake = await writeCodexExecTerminatingFake();

    await expect(
      summarizeSession(
        { head: [{ role: "user", content: "summarize but get killed" }], tail: [], omittedCount: 0 },
        {
          baseUrl: "",
          model: "codex",
          apiKey: "",
          apiFormat: "codex_exec",
          command: codexFake.executable,
          cwd: path.dirname(codexFake.executable),
        },
        requestSummaryCompletion,
      ),
    ).rejects.toThrow(/timed out/i);
  });

  it("uses Claude Code print mode with the current Claude Code settings and records the temporary session", async () => {
    const fake = await writeClaudeExecFake();
    const temporarySessions: string[] = [];

    const result = await summarizeSession(
      { head: [{ role: "user", content: "summarize using official claude" }], tail: [], omittedCount: 0 },
      {
        baseUrl: "",
        model: "claude",
        apiKey: "",
        apiFormat: "claude_exec",
        command: fake.executable,
        cwd: path.dirname(fake.executable),
        onTemporarySession: (sessionKey) => temporarySessions.push(sessionKey),
      },
      requestSummaryCompletion,
    );

    const calls = (await readFile(fake.callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(result.summary).toBe("Summarized with current Claude Code settings.");
    expect(temporarySessions).toEqual(["claude:claude-summary-1"]);
    expect(calls[0].args).toEqual(expect.arrayContaining(["--print", "--output-format", "stream-json"]));
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

describe("quoteWindowsArg", () => {
  it("wraps a plain argument in double quotes", () => {
    expect(quoteWindowsArg("codex")).toBe('"codex"');
  });

  it("doubles embedded double quotes so cmd.exe keeps them literal", () => {
    expect(quoteWindowsArg('say "hi"')).toBe('"say ""hi"""');
  });

  it("escapes percent signs to avoid env-variable expansion", () => {
    expect(quoteWindowsArg("100%done %PATH%")).toBe('"100%%done %%PATH%%"');
  });

  it("preserves newlines inside the quoted span (multi-line prompts)", () => {
    expect(quoteWindowsArg("line1\nline2")).toBe('"line1\nline2"');
  });
});
