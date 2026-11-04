import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { AgentHub as AgentHubImplementation } from "./agent-hub";
import { DEFAULT_MODEL_ID } from "../../shared/models";
import { RUNTIME_DEFINITIONS } from "../../shared/runtime-catalog";
import type { AgentChannel, AgentId, ChatRuntimeSessionState, ConfiguredAgent, RuntimeConversation } from "../../shared/types";
import { createRuntimeDriverRegistry, RuntimeDriverRegistry } from "./runtime/executor/agent-executor";
import type {
  AgentExecutionContext,
  AgentExecutorFactory,
  RuntimeAgentExecutorFactoryOptions,
} from "./runtime/executor/agent-executor";
import { createClaudeDriver } from "./runtime/executor/claude/create-claude-driver";
import { claudeCliModelForChannel } from "../agents/claude/claude-env";
import { ClaudeInteractiveSession } from "../agents/claude/claude-interactive-session";
import { claudeRuntimeStateCodec } from "../agents/claude/claude-runtime-state-codec";
import { codexRuntimeStateCodec } from "../agents/codex/codex-runtime-state-codec";
import { writeNodeCliLauncher } from "../platform/test-cli-fixtures";
import type { PersistedAppStateV5 } from "./persisted/agent-hub-persistence";
import type { AgentHubPersistedStore } from "./persisted/persisted-store";

const TEST_CODEX_AGENT_ID = "runtime-agent:codex-openai";

/**
 * No runtime binary exists inside this file.
 *
 * `loadModelChannels` falls back to spawning `codex debug models` when the
 * channel config file is not there yet, and that spawn is given the same five
 * seconds a test gets. On a machine with Codex installed the two race and which
 * one wins depends on the load, so a handful of channel tests timed out here
 * while CI — which has no Codex, and therefore fails the spawn at once — always
 * passed. Derived from the catalog so a runtime added later is covered too;
 * anything a test passes explicitly still wins.
 */
const MISSING_EXECUTABLES = Object.fromEntries(
  RUNTIME_DEFINITIONS.map((definition) => [definition.id, `missing-${definition.id}-for-test`]),
) as Partial<Record<AgentId, string>>;

type AgentHubConstructorArgs = ConstructorParameters<typeof AgentHubImplementation>;

function withoutRealRuntimes(args: AgentHubConstructorArgs): AgentHubConstructorArgs {
  const [executables, ...rest] = args;
  return [{ ...MISSING_EXECUTABLES, ...executables }, ...rest];
}

class AgentHub extends AgentHubImplementation {
  constructor(...args: AgentHubConstructorArgs) {
    super(...withoutRealRuntimes(args));
    const activeChatId = this.snapshot().activeChatId;
    if (activeChatId) this.setChatAgent(activeChatId, TEST_CODEX_AGENT_ID);
  }
}

function configuredAgent(
  id: string,
  options: {
    name?: string;
    runtimeAgentId?: AgentId;
    channelId?: string;
    modelId?: string;
    instructions?: string;
  } = {},
): ConfiguredAgent {
  const runtimeAgentId = options.runtimeAgentId ?? "codex";
  return {
    id,
    name: options.name ?? id,
    description: "",
    ...(options.instructions ? { instructions: options.instructions } : {}),
    runtimeAgentId,
    channelId:
      options.channelId ??
      (runtimeAgentId === "claude"
        ? "claude-code"
        : runtimeAgentId === "api"
          ? "api-openai"
          : runtimeAgentId === "hermes"
            ? "hermes-local"
            : "codex-openai"),
    modelId: options.modelId ?? DEFAULT_MODEL_ID,
    tags: [],
    createdAt: 1710000000000,
    updatedAt: 1710000000000,
  };
}

function addConfiguredAgents(hub: AgentHub, agents: ConfiguredAgent[]): void {
  hub.updateConfiguredAgents([...hub.snapshot().configuredAgents, ...agents]);
}

test("DeepSeek Harness never exposes persisted custom MCP bindings to execution", () => {
  const hub = new AgentHub();
  (hub as any).channels.push({
    id: "dsh-default",
    agentId: "dsh",
    label: "DeepSeek Harness",
    presetId: "dsh-default",
    models: [{ id: "default", label: "Default" }],
  });
  addConfiguredAgents(hub, [{
    ...configuredAgent("dsh-agent", {
      runtimeAgentId: "dsh",
      channelId: "dsh-default",
    }),
    mcpBindings: [{ serverId: "evidence", toolAllowlist: [] }],
  }]);
  hub.setMcpServers([{
    id: "evidence",
    name: "Evidence",
    transport: "http",
    args: [],
    url: "https://example.test/mcp",
    env: {},
    enabled: true,
    tools: [{ name: "search", inputSchema: {}, readOnly: true }],
    status: "connected",
    createdAt: 1,
    updatedAt: 1,
  }]);

  expect((hub as any).boundMcpServersForAgent("dsh-agent")).toEqual([]);
  expect((hub as any).boundMcpServersForAgent("dsh-agent", ["search"])).toEqual([]);
});

test("shutdown waits for Runtime driver lifecycle cleanup", async () => {
  let releaseShutdown: (() => void) | undefined;
  const shutdown = vi.fn(() => new Promise<void>((resolve) => {
    releaseShutdown = resolve;
  }));
  const runtimeDrivers = new RuntimeDriverRegistry([{
    runtimeId: "codex",
    surfaceSupport: [support("chat", ["oneshot"], ["fresh"])],
    getCapabilities: () => oneshotChatCapabilities("codex"),
    createOneShotExecutor: () => ({
      start: async () => undefined,
      stop: async () => undefined,
    }),
    shutdown,
  } as any]);
  const hub = new AgentHub(
    { codex: "codex-for-test", claude: "missing-claude-for-test" },
    undefined,
    runtimeDrivers,
  );

  let settled = false;
  const closing = hub.shutdown().finally(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());

  expect(settled).toBe(false);
  releaseShutdown?.();
  await closing;
  expect(settled).toBe(true);
});

function interactiveChatCapabilities(runtimeId: AgentId) {
  return {
    runtimeId,
    chatStyle: "interactive" as const,
    oneShotStyle: "oneshot" as const,
    testStyle: "oneshot" as const,
    supportsInterrupt: true,
    supportsContinue: true,
    supportsApprovalRequests: false,
    supportsUserInputRequests: false,
    resume: {
      supportsInProcessConversationResume: true,
      supportsResumeAfterDetach: false,
      supportsResumeAfterAppRestart: false,
      supportsTurnResume: false,
    },
  };
}

function oneshotChatCapabilities(runtimeId: AgentId) {
  return {
    runtimeId,
    chatStyle: "oneshot" as const,
    oneShotStyle: "oneshot" as const,
    testStyle: "oneshot" as const,
    supportsInterrupt: false,
    supportsContinue: false,
    supportsApprovalRequests: false,
    supportsUserInputRequests: false,
    resume: {
      supportsInProcessConversationResume: false,
      supportsResumeAfterDetach: false,
      supportsResumeAfterAppRestart: false,
      supportsTurnResume: false,
    },
  };
}

function runtimeSessionCapabilities(): ChatRuntimeSessionState["capabilities"] {
  return {
    supportsInProcessConversationResume: true,
    supportsResumeAfterDetach: true,
    supportsResumeAfterAppRestart: true,
    supportsTurnResume: false,
    supportsInterrupt: true,
    supportsContinue: true,
    supportsApprovalRequests: true,
    supportsUserInputRequests: true,
  };
}

function runtimeConversation(runtimeId: AgentId, payload: Record<string, unknown>): RuntimeConversation {
  return {
    runtimeId,
    codecVersion: "v1",
    payload,
  };
}

function support(
  surface: "chat" | "oneshot" | "channel-test" | "cleanup",
  executionModes: Array<"interactive" | "oneshot">,
  continuationPolicies: Array<"fresh" | "resume-preferred" | "resume-required">,
) {
  return {
    surface,
    executionModes,
    continuationPolicies,
  };
}

function createHubWithClaudeOneShot(
  runOneShot: (input: any) => Promise<void>,
  executables: Partial<Record<AgentId, string>> = {},
): AgentHub {
  let hub: AgentHub;
  const resolvedExecutables = {
    codex: executables.codex ?? "missing-codex-for-test",
    claude: executables.claude ?? "missing-claude-for-test",
    dsh: executables.dsh ?? "missing-dsh-for-test",
    api: executables.api ?? "api",
    hermes: executables.hermes ?? "missing-hermes-for-test",
    opencode: executables.opencode ?? "missing-opencode-for-test",
    openclaw: executables.openclaw ?? "missing-openclaw-for-test",
  };
  const options: RuntimeAgentExecutorFactoryOptions = {
    executables: resolvedExecutables,
    channelById: (channelId) => (hub as any).channelById(channelId),
    mcpServersForAgent: (configuredAgentId) => (hub as any).boundMcpServersForAgent(configuredAgentId),
  };
  const defaultDrivers = createRuntimeDriverRegistry(options);
  const runtimeDrivers = new RuntimeDriverRegistry([
    defaultDrivers.driverFor("codex"),
    createClaudeDriver(options, { runOneShot }),
    defaultDrivers.driverFor("api"),
    defaultDrivers.driverFor("hermes"),
    defaultDrivers.driverFor("opencode"),
    defaultDrivers.driverFor("openclaw"),
  ]);
  hub = new AgentHub(executables, undefined, runtimeDrivers);
  return hub;
}

function createHubWithTwoCodexChannels(): AgentHub {
  const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
  (hub as any).channels = [
    {
      id: "codex-openai",
      agentId: "codex",
      label: "Codex OpenAI",
      models: [{ id: "default", label: "Default" }, { id: "gpt-5.5", label: "GPT-5.5" }],
    },
    {
      id: "codex-openrouter",
      agentId: "codex",
      label: "Codex OpenRouter",
      models: [{ id: "default", label: "Default" }, { id: "gpt-5.5", label: "GPT-5.5" }],
    },
    {
      id: "claude-code",
      agentId: "claude",
      label: "Claude Code",
      models: [{ id: "default", label: "Default" }],
    },
  ];
  return hub;
}

function createHubWithCodexAndClaudeAgents(): AgentHub {
  const hub = createHubWithTwoCodexChannels();
  addConfiguredAgents(hub, [
    configuredAgent("codex-agent", { runtimeAgentId: "codex", channelId: "codex-openai", modelId: "gpt-5.5" }),
    configuredAgent("claude-agent", { runtimeAgentId: "claude", channelId: "claude-code", modelId: "default" }),
  ]);
  return hub;
}

test("claude runtime advertises interactive resume support without transport-specific branching", async () => {
  const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "claude" });
  addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);

  const capabilities = (hub as any).runtimeDrivers.driverFor("claude").getCapabilities({
    id: "claude",
    label: "Claude",
    command: "claude",
    version: "test",
    available: true,
  });

  expect(capabilities.resume).toMatchObject({
    supportsInProcessConversationResume: true,
    supportsResumeAfterDetach: true,
    supportsResumeAfterAppRestart: true,
  });
});

test("ignores legacy CLAUDE_INTERACTIVE_TRANSPORT selectors and keeps Claude resume semantics stable", async () => {
  const original = process.env.CLAUDE_INTERACTIVE_TRANSPORT;
  process.env.CLAUDE_INTERACTIVE_TRANSPORT = "runner";
  try {
    const capabilities = createRuntimeDriverRegistry({
      executables: { codex: "codex", claude: "claude", dsh: "dsh", api: "api", hermes: "hermes", opencode: "opencode", openclaw: "openclaw" },
      channelById: () => undefined,
    }).driverFor("claude").getCapabilities({
      id: "claude",
      label: "Claude",
      command: "claude",
      version: "test",
      available: true,
    });

    expect(capabilities.resume).toMatchObject({
      supportsInProcessConversationResume: true,
      supportsResumeAfterDetach: true,
      supportsResumeAfterAppRestart: true,
    });
  } finally {
    if (original === undefined) delete process.env.CLAUDE_INTERACTIVE_TRANSPORT;
    else process.env.CLAUDE_INTERACTIVE_TRANSPORT = original;
  }
});

test("api runtime advertises oneshot chat style", () => {
  const capabilities = createRuntimeDriverRegistry({
    executables: { codex: "codex", claude: "claude", dsh: "dsh", api: "api", hermes: "hermes", opencode: "opencode", openclaw: "openclaw" },
    channelById: () => undefined,
  }).driverFor("api").getCapabilities({
    id: "api",
    label: "API",
    command: "api",
    version: "test",
    available: true,
  });

  expect(capabilities.chatStyle).toBe("oneshot");
});

test("configured Agent one-shot execution forwards Agent instructions", async () => {
  const askOneShot = vi.fn(async () => ({
    content: "hermes answer",
  }));
  const hub = new AgentHub(
    { codex: "missing-codex-for-test", claude: "missing-claude-for-test", hermes: "missing-hermes-for-test" } as any,
    undefined,
    new RuntimeDriverRegistry([
      {
        runtimeId: "hermes",
        surfaceSupport: [support("oneshot", ["oneshot"], ["fresh"])],
        getCapabilities: () => oneshotChatCapabilities("hermes"),
        createOneShotExecutor: () => ({ start: async () => undefined, stop: async () => undefined }),
        askOneShot,
      },
    ]),
  );

  (hub as any).channels = [
    ...(hub as any).channels,
    {
      id: "hermes-local",
      agentId: "hermes",
      label: "Hermes",
      models: [{ id: "default", label: "Default" }],
    },
  ];
  (hub as any).runtimes.set("hermes", {
    id: "hermes",
    label: "Hermes",
    command: "hermes",
    version: "test",
    available: true,
  });
  addConfiguredAgents(hub, [configuredAgent("hermes-agent", {
    runtimeAgentId: "hermes",
    channelId: "hermes-local",
    instructions: "Follow the configured Agent policy.",
  })]);

  const response = await hub.askConfiguredAgent({
    invocation: { surface: "evaluation" },
    prompt: "Evaluate the answer",
    configuredAgentId: "hermes-agent",
    runtimeId: "hermes",
    executionMode: "oneshot",
    continuationPolicy: "fresh",
    runtimeConfig: { model: DEFAULT_MODEL_ID },
  });

  expect(response).toEqual({ content: "hermes answer" });
  expect(askOneShot).toHaveBeenCalledWith(expect.objectContaining({
    configuredAgentId: "hermes-agent",
    developerInstructions: "Follow the configured Agent policy.",
  }));
});


async function writeCodexAppServerFake(dir: string): Promise<{ executable: string; callsPath: string }> {
  const callsPath = path.join(dir, "calls.jsonl");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");

const callsPath = ${JSON.stringify(callsPath)};
if (!process.argv.includes("app-server")) {
  console.error("expected app-server");
  process.exit(2);
}

const models = [
  { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", hidden: false, isDefault: true },
  { id: "gpt-6-preview", model: "gpt-6-preview", displayName: "GPT-6 Preview", hidden: false, isDefault: false }
];
const marketplaces = [
  {
    name: "openai-primary-runtime",
    path: "/tmp/openai-primary-runtime/marketplace.json",
    plugins: [
      { id: "documents@openai-primary-runtime", name: "documents", installed: true, enabled: true, localVersion: "1.0.0" },
      { id: "spreadsheets@openai-primary-runtime", name: "spreadsheets", installed: true, enabled: false, localVersion: "1.0.0" }
    ]
  },
  {
    name: "openai-curated",
    path: null,
    plugins: [
      { id: "github@openai-curated", name: "github", installed: false, enabled: false, localVersion: null }
    ]
  }
];

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method) {
    fs.appendFileSync(callsPath, JSON.stringify({ method: message.method, params: message.params ?? null }) + "\\n");
  }
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "config/read") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        config: {
          model: "gpt-5.5",
          model_provider: "openai",
          approval_policy: "never",
          sandbox_mode: "danger-full-access",
          model_reasoning_effort: "high",
          web_search: "enabled"
        },
        origins: {},
        layers: null
      }
    });
    return;
  }
  if (message.method === "model/list") {
    write({ jsonrpc: "2.0", id: message.id, result: { data: models, nextCursor: null } });
    return;
  }
  if (message.method === "plugin/list") {
    write({ jsonrpc: "2.0", id: message.id, result: { marketplaces, marketplaceLoadErrors: [], featuredPluginIds: [] } });
    return;
  }
  if (message.method === "mcpServerStatus/list") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        data: [{ name: "openaiDeveloperDocs", serverInfo: { name: "OpenAI Docs" }, tools: { search_openai_docs: { name: "search_openai_docs" } }, resources: [], resourceTemplates: [], authStatus: "unsupported" }],
        nextCursor: null
      }
    });
    return;
  }
  write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method " + message.method } });
});
`;
  const executable = await writeNodeCliLauncher(dir, "codex-fake", script);
  return { executable, callsPath };
}

async function writeSequentialCodexFake(dir: string): Promise<{ executable: string; callsPath: string }> {
  const callsPath = path.join(dir, "calls.jsonl");
  const counterPath = path.join(dir, "counter.txt");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");

const callsPath = ${JSON.stringify(callsPath)};
const counterPath = ${JSON.stringify(counterPath)};
let threadIndex = 0;
fs.appendFileSync(callsPath, JSON.stringify({ method: "process/argv", params: { args: process.argv.slice(2) } }) + "\\n");

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function record(message) {
  if (!message.method) return;
  fs.appendFileSync(callsPath, JSON.stringify({ method: message.method, params: message.params ?? null }) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  record(message);
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "mcpServerStatus/list") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        data: [{
          name: "agent_recall",
          tools: { search_docs: {} },
          resources: [],
          resourceTemplates: [],
          authStatus: "unsupported"
        }],
        nextCursor: null
      }
    });
    return;
  }
  if (message.method === "thread/start") {
    threadIndex += 1;
    write({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-" + threadIndex } } });
    return;
  }
  if (message.method === "thread/resume") {
    write({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    const current = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, "utf8") : "0") + 1;
    fs.writeFileSync(counterPath, String(current));
    const text = "artifact-" + current;
    write({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-" + current } } });
    setTimeout(() => {
      write({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: text } });
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }]
          }
        }
      });
    }, 10);
    return;
  }
  write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method " + message.method } });
});
`;
  const executable = await writeNodeCliLauncher(dir, "codex-sequential-fake", script);
  return { executable, callsPath };
}

async function writeTurnStartFailureCodexFake(dir: string): Promise<{ executable: string; callsPath: string }> {
  const callsPath = path.join(dir, "turn-start-failure-calls.jsonl");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");

const callsPath = ${JSON.stringify(callsPath)};

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function record(message) {
  if (!message.method) return;
  fs.appendFileSync(callsPath, JSON.stringify({ method: message.method, params: message.params ?? null }) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  record(message);
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    write({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (message.method === "thread/resume") {
    write({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "turn failed" } });
    return;
  }
  write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method " + message.method } });
});
`;
  const executable = await writeNodeCliLauncher(dir, "codex-turn-start-failure-fake", script);
  return { executable, callsPath };
}

async function writeCodexExecFake(dir: string): Promise<{ executable: string; callsPath: string; sessionId: string }> {
  const callsPath = path.join(dir, "exec-calls.jsonl");
  const sessionId = "019ed5a0-0000-7000-8000-000000000123";
  const script = `#!/usr/bin/env node
const fs = require("fs");

const callsPath = ${JSON.stringify(callsPath)};
const sessionId = ${JSON.stringify(sessionId)};
const args = process.argv.slice(2);
fs.appendFileSync(callsPath, JSON.stringify({ args }) + "\\n");

if (args[0] === "archive") {
  process.exit(args[1] === sessionId ? 0 : 3);
}

if (args[0] !== "exec") {
  console.error("expected exec");
  process.exit(2);
}

process.stdout.write(JSON.stringify({ session_id: sessionId }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }) + "\\n");
`;
  const executable = await writeNodeCliLauncher(dir, "codex-exec-fake", script);
  return { executable, callsPath, sessionId };
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  const timeoutMs = 4_000;
  const startedAt = Date.now();
  let value = read();
  while (!predicate(value)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = read();
  }
  return value;
}

describe("AgentHub chat sessions", () => {
  test("coalesces bursty assistant deltas into one snapshot and flushes terminal events immediately", async () => {
    vi.useFakeTimers();
    const hub = new AgentHub();
    const listener = vi.fn();
    const unsubscribe = hub.onChange(listener);
    listener.mockClear();
    try {
      const chat = (hub as any).chats.get(hub.snapshot().activeChatId!);
      for (let index = 0; index < 20; index += 1) {
        (hub as any).handleAgentEvent(chat, { type: "delta", content: String(index) });
      }

      expect(listener).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(40);
      expect(listener).toHaveBeenCalledTimes(1);

      (hub as any).handleAgentEvent(chat, { type: "completed", content: "done" });
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      await hub.shutdown();
      vi.useRealTimers();
    }
  });

  test("creates managed Runtime Agents once without binding their later edits to runtime configs", () => {
    const hub = new AgentHub();
    (hub as any).channels = [
      {
        id: "codex-openai",
        agentId: "codex",
        label: "Codex Official",
        models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
      },
      {
        id: "codex-glm",
        agentId: "codex",
        label: "Codex GLM",
        models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
      },
    ];
    (hub as any).installRestoredConfiguredAgents([]);

    expect(hub.snapshot().configuredAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: TEST_CODEX_AGENT_ID, name: "Codex Official", channelId: "codex-openai", managed: true }),
        expect.objectContaining({ id: "runtime-agent:codex-glm", name: "Codex GLM", channelId: "codex-glm", managed: true }),
      ]),
    );

    const existing = hub.snapshot().configuredAgents.map((agent) =>
      agent.id === "runtime-agent:codex-glm"
        ? {
            ...agent,
            name: "My Reviewer",
            channelId: "codex-openai",
            runtimeAgentId: "codex" as const,
            modelId: DEFAULT_MODEL_ID,
            managed: false,
          }
        : agent,
    );
    (hub as any).channels[1].label = "Codex GLM Updated";
    (hub as any).installRestoredConfiguredAgents(existing);
    expect(hub.snapshot().configuredAgents.find((agent) => agent.id === "runtime-agent:codex-glm")).toMatchObject({
      name: "My Reviewer",
      channelId: "codex-openai",
      runtimeAgentId: "codex",
      modelId: DEFAULT_MODEL_ID,
    });
    expect(hub.snapshot().configuredAgents.find((agent) => agent.id === "runtime-agent:codex-glm")?.managed).toBeUndefined();
  });

  test("migrates the legacy default Agent identity into the Codex Runtime Agent", () => {
    const hub = new AgentHubImplementation();
    const restored = (hub as any).restoreConfiguredAgent({
      id: "default-agent",
      name: "Default Agent",
      description: "",
      runtimeAgentId: "codex",
      channelId: "codex-openai",
      modelId: DEFAULT_MODEL_ID,
      tags: [],
      managed: true,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(restored).toMatchObject({
      id: TEST_CODEX_AGENT_ID,
      name: "Codex OpenAI",
      runtimeAgentId: "codex",
      channelId: "codex-openai",
    });
    expect(hub.snapshot().configuredAgents.some((agent) => agent.id === "default-agent")).toBe(false);
  });

  test("restores a configured agent reasoning effort supported by its model", () => {
    const hub = new AgentHub();
    (hub as any).channels = [{
      id: "codex-openai",
      agentId: "codex",
      label: "Codex Official",
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", reasoningEfforts: ["low", "xhigh", "ultra"] }],
    }];
    (hub as any).installRestoredConfiguredAgents([{
      id: "sol-agent",
      name: "Sol Agent",
      description: "",
      instructions: "Always include the verification result.",
      runtimeAgentId: "codex",
      channelId: "codex-openai",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }]);

    expect(hub.snapshot().configuredAgents.find((agent) => agent.id === "sol-agent")?.reasoningEffort).toBe("xhigh");
  });

  test("keeps a deleted managed agent deleted across saves, reseeds, and restores", () => {
    const hub = new AgentHub();
    (hub as any).channels = [
      {
        id: "codex-openai",
        agentId: "codex",
        label: "Codex Official",
        models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
      },
      {
        id: "codex-glm",
        agentId: "codex",
        label: "Codex GLM",
        models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
      },
    ];

    // Omitting a managed agent from the saved list must delete it.
    hub.updateConfiguredAgents(
      hub.snapshot().configuredAgents.filter((agent) => agent.id !== "runtime-agent:codex-glm"),
      { detectDeletedManagedAgents: true },
    );
    expect(hub.snapshot().configuredAgents.find((agent) => agent.id === "runtime-agent:codex-glm")).toBeUndefined();

    // Re-seeding from scratch must not recreate the deleted agent while keeping other managed agents.
    (hub as any).installRestoredConfiguredAgents([]);
    expect(hub.snapshot().configuredAgents.find((agent) => agent.id === "runtime-agent:codex-glm")).toBeUndefined();
    expect(hub.snapshot().configuredAgents.find((agent) => agent.id === TEST_CODEX_AGENT_ID)).toBeDefined();

    // The deletion survives a persistence round-trip.
    const payload = (hub as any).buildPersistedPayload();
    const restoredHub = new AgentHub();
    expect((restoredHub as any).restorePersistedState(payload)).toBe(true);
    expect(restoredHub.snapshot().configuredAgents.find((agent) => agent.id === "runtime-agent:codex-glm")).toBeUndefined();
    expect(restoredHub.snapshot().configuredAgents.find((agent) => agent.id === TEST_CODEX_AGENT_ID)).toBeDefined();
  });

  test("rejects deleting an execution config used by its managed Agent before changing state", async () => {
    const hub = new AgentHub();
    const before = hub.snapshot();
    const channel = before.channels[0]!;

    await expect(hub.saveModelChannels(
      before.channels.filter((item) => item.id !== channel.id),
      { validateDeletedChannelReferences: true },
    ))
      .rejects.toThrow(/is used by Agent/);
    expect(hub.snapshot().channels).toEqual(before.channels);
    expect(hub.snapshot().configuredAgents).toEqual(before.configuredAgents);
  });

  test("rejects deleting an Agent referenced by Chat", () => {
    const cases: Array<{ expected: RegExp; reference: (hub: AgentHub) => void }> = [
      {
        expected: /Chat/,
        reference: (hub) => { hub.createChat("worker"); },
      },
    ];

    for (const scenario of cases) {
      const hub = new AgentHub();
      addConfiguredAgents(hub, [configuredAgent("worker", { name: "Worker" })]);
      scenario.reference(hub);
      const before = hub.snapshot().configuredAgents;

      expect(() => hub.updateConfiguredAgents(
        before.filter((agent) => agent.id !== "worker"),
        { detectDeletedManagedAgents: true },
      )).toThrow(scenario.expected);
      expect(hub.snapshot().configuredAgents).toEqual(before);
    }
  });

  test("allows deleting every configured agent without forcing a default agent back", () => {
    const hub = new AgentHub();
    (hub as any).channels = [
      {
        id: "codex-openai",
        agentId: "codex",
        label: "Codex Official",
        models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
      },
    ];

    (hub as any).chats.clear();
    hub.updateConfiguredAgents([], { detectDeletedManagedAgents: true });
    expect(hub.snapshot().configuredAgents).toEqual([]);

    (hub as any).installRestoredConfiguredAgents([]);
    expect(hub.snapshot().configuredAgents).toEqual([]);

    const payload = (hub as any).buildPersistedPayload();
    const restoredHub = new AgentHub();
    expect((restoredHub as any).restorePersistedState(payload)).toBe(true);
    expect(restoredHub.snapshot().configuredAgents).toEqual([]);
  });

  test("prunes deleted markers when their channel no longer exists", () => {
    const hub = new AgentHub();
    (hub as any).channels = [
      {
        id: "codex-openai",
        agentId: "codex",
        label: "Codex Official",
        models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
      },
    ];
    (hub as any).chats.clear();
    hub.updateConfiguredAgents([], { detectDeletedManagedAgents: true });
    expect((hub as any).deletedManagedConfiguredAgentIds.has(TEST_CODEX_AGENT_ID)).toBe(true);

    // Removing the channel prunes the marker so a future channel with the same id can be seeded again.
    (hub as any).channels = [];
    (hub as any).installRestoredConfiguredAgents([]);
    expect((hub as any).deletedManagedConfiguredAgentIds.has(TEST_CODEX_AGENT_ID)).toBe(false);
  });

  test("stores tool calls and results as structured chat events", () => {
    const hub = new AgentHub();
    const chatId = hub.snapshot().activeChatId!;
    const chat = (hub as any).chats.get(chatId);

    (hub as any).handleAgentEvent(chat, {
      type: "tool_call",
      name: "shell_command",
      content: "ls src",
    });
    (hub as any).handleAgentEvent(chat, {
      type: "tool_result",
      name: "shell_command",
      content: "App.tsx",
    });

    const activeChat = hub.snapshot().chats.find((item) => item.id === chatId);
    expect(activeChat?.messages).toHaveLength(1);
    expect(activeChat?.messages[0]).toMatchObject({
      role: "assistant",
      content: "",
      events: [
        expect.objectContaining({ type: "tool_call", name: "shell_command", content: "ls src" }),
        expect.objectContaining({ type: "tool_result", name: "shell_command", content: "App.tsx" }),
      ],
    });
  });

  test("runs chat turns through the configured agent executor", async () => {
    const events: any[] = [];
    const executorFactory: AgentExecutorFactory = {
      create: (context: any) => ({
        start: async () => {
          events.push(context);
          context.emit({
            type: "runtime_conversation",
            runtimeConversation: runtimeConversation("codex", { native: { threadId: "executor-session" } }),
          });
          context.emit({ type: "delta", content: "executor response" });
          context.emit({ type: "completed" });
        },
        stop: async () => undefined,
      }),
    };
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["oneshot"], ["fresh", "resume-preferred"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => oneshotChatCapabilities("codex"),
        createOneShotExecutor: (context: AgentExecutionContext) => executorFactory.create(context),
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "missing-codex-for-test", claude: "missing-claude-for-test" },
      executorFactory,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });
    (hub as any).channels = [{
      id: "codex-openai",
      agentId: "codex",
      label: "Codex Official",
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", reasoningEfforts: ["low", "xhigh", "ultra"] }],
    }];
    hub.updateConfiguredAgents([{
      id: "sol-agent",
      name: "Sol Agent",
      description: "",
      instructions: "Always include the verification result.",
      runtimeAgentId: "codex",
      channelId: "codex-openai",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }]);
    const chatId = hub.snapshot().activeChatId!;
    hub.setChatAgent(chatId, "sol-agent");

    await hub.sendPrompt("Hello", chatId);
    await waitFor(() => hub.snapshot().chats.find((chat) => chat.id === chatId), (chat) => chat?.running === false);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runtimeId: "codex",
      runtimeConfig: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
      prompt: "Hello",
      continuationPolicy: "resume-preferred",
      developerInstructions: expect.stringContaining("desktop chat UI"),
    });
    expect(events[0].developerInstructions).toContain("Always include the verification result.");
    const activeChat = hub.snapshot().chats.find((chat) => chat.id === chatId);
    expect(activeChat?.runtimeConversation).toEqual(runtimeConversation("codex", { native: { threadId: "executor-session" } }));
    expect(activeChat?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Hello" }),
      expect.objectContaining({ role: "assistant", content: "executor response" }),
    ]);
  });

  test("does not eagerly create interactive sessions while restoring persisted chats", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-restore-interactive-"));
    const storagePath = path.join(dir, "app-chats.json");
    await writeFile(
      storagePath,
      JSON.stringify({
        version: 5,
        activeChatId: "chat-1",
        workDir: dir,
        sessions: [
          {
            id: "chat-1",
            title: "Restored interactive chat",
            configuredAgentId: TEST_CODEX_AGENT_ID,
            modelId: DEFAULT_MODEL_ID,
            runtimeState: {
              executionStyle: "interactive",
              attachmentState: "detached",
              attachmentGeneration: 0,
              capabilities: {
                supportsInProcessConversationResume: true,
                supportsResumeAfterDetach: false,
                supportsResumeAfterAppRestart: false,
                supportsTurnResume: false,
                supportsInterrupt: true,
                supportsContinue: true,
                supportsApprovalRequests: false,
                supportsUserInputRequests: false,
              },
            },
            runtimeConversation: {
              runtimeId: "codex",
              codecVersion: "v1",
              payload: { native: { threadId: "thread-restore-1" } },
            },
            createdAt: 1710000000000,
            updatedAt: 1710000000000,
          },
        ],
        messages: [],
        events: [],
        tasks: [],
        taskMessages: [],
        taskEvents: [],
      }),
      "utf8",
    );

    const createInteractiveSession = vi.fn();
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["interactive"], ["fresh", "resume-preferred", "resume-required"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: () => ({
          start: async () => undefined,
          stop: async () => undefined,
        }),
        createInteractiveSession,
      } as any,
    ]);

    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      undefined,
      runtimeDrivers,
    );
    await hub.loadPersistedState(storagePath);

    expect(createInteractiveSession).not.toHaveBeenCalled();
    expect(hub.snapshot().chats.find((chat) => chat.id === "chat-1")?.runtimeState?.attachmentState).toBe("detached");
  });

  test("does not restore interactive runtime state when chat surface support is undeclared", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-restore-missing-chat-support-"));
    const storagePath = path.join(dir, "app-chats.json");
    await writeFile(
      storagePath,
      JSON.stringify({
        version: 5,
        activeChatId: "chat-1",
        workDir: dir,
        sessions: [
          {
            id: "chat-1",
            title: "Restored chat without declared support",
            configuredAgentId: TEST_CODEX_AGENT_ID,
            modelId: DEFAULT_MODEL_ID,
            runtimeState: {
              executionStyle: "interactive",
              attachmentState: "detached",
              attachmentGeneration: 0,
              capabilities: {
                supportsInProcessConversationResume: true,
                supportsResumeAfterDetach: false,
                supportsResumeAfterAppRestart: false,
                supportsTurnResume: false,
                supportsInterrupt: true,
                supportsContinue: true,
                supportsApprovalRequests: false,
                supportsUserInputRequests: false,
              },
            },
            runtimeConversation: {
              runtimeId: "codex",
              codecVersion: "v1",
              payload: { native: { threadId: "thread-restore-undeclared-1" } },
            },
            createdAt: 1710000000000,
            updatedAt: 1710000000000,
          },
        ],
        messages: [],
        events: [],
        tasks: [],
        taskMessages: [],
        taskEvents: [],
      }),
      "utf8",
    );

    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("oneshot", ["oneshot"], ["fresh"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: () => ({
          start: async () => undefined,
          stop: async () => undefined,
        }),
      } as any,
    ]);

    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      undefined,
      runtimeDrivers,
    );
    await hub.loadPersistedState(storagePath);

    const restoredChat = hub.snapshot().chats.find((chat) => chat.id === "chat-1");
    expect(restoredChat?.runtimeState).toBeUndefined();
    expect(restoredChat?.runtimeConversation).toEqual(
      runtimeConversation("codex", { native: { threadId: "thread-restore-undeclared-1" } }),
    );
  });

  test("routes interactive chats through the shared session manager when a driver supports it", async () => {
    const executorFactory: AgentExecutorFactory = {
      create: () => ({
        start: async () => {
          throw new Error("one-shot executor path should not run");
        },
        stop: async () => undefined,
      }),
    };
    let currentConversation: RuntimeConversation | undefined;
    const session = {
      reconfigure: vi.fn(),
      ensureAttached: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async (prompt: string) => {
        expect(prompt).toBe("Hello");
        currentConversation = runtimeConversation("codex", { native: { threadId: "interactive-session-1" } });
        interactiveContext.emit({
          type: "runtime_conversation",
          runtimeConversation: currentConversation,
        });
        interactiveContext.emit({ type: "delta", content: "interactive response" });
        interactiveContext.emit({ type: "completed" });
      }),
      interrupt: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      detachIfStillExpired: vi.fn(async () => undefined),
      snapshot: () => ({
        runtimeState: {
          executionStyle: "interactive" as const,
          attachmentState: "idle" as const,
          attachmentGeneration: 1,
          capabilities: {
            supportsInProcessConversationResume: true,
            supportsResumeAfterDetach: false,
            supportsResumeAfterAppRestart: false,
            supportsTurnResume: false,
            supportsInterrupt: true,
            supportsContinue: true,
            supportsApprovalRequests: false,
            supportsUserInputRequests: false,
          },
        },
        ...(currentConversation ? { runtimeConversation: currentConversation } : {}),
      }),
    };
    let interactiveContext: any;
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["interactive"], ["fresh", "resume-preferred", "resume-required"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: () => ({
          start: async () => {
            throw new Error("driver one-shot path should not run");
          },
          stop: async () => undefined,
        }),
        createInteractiveSession: (context: any) => {
          interactiveContext = context;
          return session;
        },
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      executorFactory,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });
    const chatId = hub.snapshot().activeChatId!;

    await hub.sendPrompt("Hello", chatId);
    const activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(session.sendPrompt).toHaveBeenCalledWith("Hello");
    expect(activeChat?.runtimeConversation).toEqual(runtimeConversation("codex", { native: { threadId: "interactive-session-1" } }));
    expect(activeChat?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Hello" }),
      expect.objectContaining({ role: "assistant", content: "interactive response" }),
    ]);
  });

  test("uses chat surface support instead of capabilities.chatStyle when chat defaults select interactive", async () => {
    const executorFactory: AgentExecutorFactory = {
      create: () => ({
        start: async () => {
          throw new Error("one-shot executor path should not run");
        },
        stop: async () => undefined,
      }),
    };
    let interactiveContext: any;
    const session = {
      reconfigure: vi.fn(),
      ensureAttached: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async (prompt: string) => {
        expect(prompt).toBe("Hello");
        interactiveContext.emit({ type: "delta", content: "interactive via support matrix" });
        interactiveContext.emit({ type: "completed" });
      }),
      interrupt: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      detachIfStillExpired: vi.fn(async () => undefined),
      snapshot: () => ({
        runtimeState: {
          executionStyle: "interactive" as const,
          attachmentState: "idle" as const,
          attachmentGeneration: 1,
          capabilities: runtimeSessionCapabilities(),
        },
      }),
    };
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["interactive"], ["fresh", "resume-preferred", "resume-required"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => oneshotChatCapabilities("codex"),
        createOneShotExecutor: () => ({
          start: async () => {
            throw new Error("driver one-shot path should not run");
          },
          stop: async () => undefined,
        }),
        createInteractiveSession: (context: any) => {
          interactiveContext = context;
          return session;
        },
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      executorFactory,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });

    const chatId = hub.snapshot().activeChatId!;
    await hub.sendPrompt("Hello", chatId);
    const activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(session.sendPrompt).toHaveBeenCalledWith("Hello");
    expect(interactiveContext).toMatchObject({
      executionMode: "interactive",
      continuationPolicy: "resume-preferred",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
    });
    expect(activeChat?.runtimeState?.executionStyle).toBe("interactive");
    expect(activeChat?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Hello" }),
      expect.objectContaining({ role: "assistant", content: "interactive via support matrix" }),
    ]);
  });

  test("uses declared chat continuation support when interactive chats only allow resume-required", async () => {
    const executorFactory: AgentExecutorFactory = {
      create: () => ({
        start: async () => {
          throw new Error("one-shot executor path should not run");
        },
        stop: async () => undefined,
      }),
    };
    const existingConversation = runtimeConversation("codex", { native: { threadId: "resume-required-thread-1" } });
    let interactiveContext: any;
    const session = {
      reconfigure: vi.fn(),
      ensureAttached: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async (prompt: string) => {
        expect(prompt).toBe("Hello again");
        interactiveContext.emit({ type: "delta", content: "interactive resume-required response" });
        interactiveContext.emit({ type: "completed" });
      }),
      interrupt: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      detachIfStillExpired: vi.fn(async () => undefined),
      snapshot: () => ({
        runtimeState: {
          executionStyle: "interactive" as const,
          attachmentState: "idle" as const,
          attachmentGeneration: 1,
          capabilities: runtimeSessionCapabilities(),
        },
        runtimeConversation: existingConversation,
      }),
    };
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["interactive"], ["resume-required"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: () => ({
          start: async () => {
            throw new Error("driver one-shot path should not run");
          },
          stop: async () => undefined,
        }),
        createInteractiveSession: (context: any) => {
          interactiveContext = context;
          return session;
        },
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      executorFactory,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });

    const chatId = hub.snapshot().activeChatId!;
    (hub as any).chats.get(chatId).runtimeConversation = existingConversation;

    await hub.sendPrompt("Hello again", chatId);
    const activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(session.sendPrompt).toHaveBeenCalledWith("Hello again");
    expect(interactiveContext).toMatchObject({
      executionMode: "interactive",
      continuationPolicy: "resume-required",
      runtimeConversation: existingConversation,
      runtimeConfig: { model: DEFAULT_MODEL_ID },
    });
    expect(activeChat?.runtimeConversation).toEqual(existingConversation);
    expect(activeChat?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Hello again" }),
      expect.objectContaining({ role: "assistant", content: "interactive resume-required response" }),
    ]);
  });

  test("degrades to fresh when declared chat continuation policies are unusable without a runtime state codec", async () => {
    const executorCalls: any[] = [];
    const executorFactory: AgentExecutorFactory = {
      create: (context: any) => ({
        start: async () => {
          executorCalls.push(context);
          context.emit({ type: "delta", content: "oneshot without resumable state" });
          context.emit({ type: "completed" });
        },
        stop: async () => undefined,
      }),
    };
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["oneshot"], ["resume-preferred"])],
        getCapabilities: () => oneshotChatCapabilities("codex"),
        createOneShotExecutor: (context: AgentExecutionContext) => executorFactory.create(context),
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      executorFactory,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });

    const chatId = hub.snapshot().activeChatId!;
    await hub.sendPrompt("Hello", chatId);
    const activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toMatchObject({
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      prompt: "Hello",
    });
    expect(executorCalls[0].runtimeConversation).toBeUndefined();
    expect(activeChat?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Hello" }),
      expect.objectContaining({ role: "assistant", content: "oneshot without resumable state" }),
    ]);
  });

  test("uses chat surface support instead of capabilities.chatStyle when chat defaults select oneshot", async () => {
    const executorCalls: any[] = [];
    const executorFactory: AgentExecutorFactory = {
      create: (context: any) => ({
        start: async () => {
          executorCalls.push(context);
          context.emit({ type: "delta", content: "oneshot via support matrix" });
          context.emit({ type: "completed" });
        },
        stop: async () => undefined,
      }),
    };
    const createInteractiveSession = vi.fn(() => ({
      reconfigure: vi.fn(),
      ensureAttached: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      detachIfStillExpired: vi.fn(async () => undefined),
      snapshot: () => ({
        runtimeState: {
          executionStyle: "interactive" as const,
          attachmentState: "idle" as const,
          attachmentGeneration: 1,
          capabilities: runtimeSessionCapabilities(),
        },
      }),
    }));
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["oneshot"], ["fresh"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: (context: AgentExecutionContext) => executorFactory.create(context),
        createInteractiveSession,
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      executorFactory,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });

    const chatId = hub.snapshot().activeChatId!;
    await hub.sendPrompt("Hello", chatId);
    const activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(createInteractiveSession).not.toHaveBeenCalled();
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toMatchObject({
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      prompt: "Hello",
    });
    expect(activeChat?.runtimeState).toBeUndefined();
    expect(activeChat?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Hello" }),
      expect.objectContaining({ role: "assistant", content: "oneshot via support matrix" }),
    ]);
  });

  test("requires declared chat surface support before treating chat defaults as interactive", async () => {
    const executorCalls: any[] = [];
    const executorFactory: AgentExecutorFactory = {
      create: (context: any) => ({
        start: async () => {
          executorCalls.push(context);
          context.emit({ type: "delta", content: "oneshot without declared chat support" });
          context.emit({ type: "completed" });
        },
        stop: async () => undefined,
      }),
    };
    const createInteractiveSession = vi.fn(() => ({
      reconfigure: vi.fn(),
      ensureAttached: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      detachIfStillExpired: vi.fn(async () => undefined),
      snapshot: () => ({
        runtimeState: {
          executionStyle: "interactive" as const,
          attachmentState: "idle" as const,
          attachmentGeneration: 1,
          capabilities: runtimeSessionCapabilities(),
        },
      }),
    }));
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("oneshot", ["oneshot"], ["fresh"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: (context: AgentExecutionContext) => executorFactory.create(context),
        createInteractiveSession,
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      executorFactory,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });

    const chatId = hub.snapshot().activeChatId!;
    await hub.sendPrompt("Hello", chatId);
    const activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(createInteractiveSession).not.toHaveBeenCalled();
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toMatchObject({
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      prompt: "Hello",
    });
    expect(activeChat?.runtimeState).toBeUndefined();
    expect(activeChat?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Hello" }),
      expect.objectContaining({ role: "assistant", content: "oneshot without declared chat support" }),
    ]);
  });

  test("falls back to oneshot when chat surface support is declared but has no usable execution mode", async () => {
    const executorCalls: any[] = [];
    const executorFactory: AgentExecutorFactory = {
      create: (context: any) => ({
        start: async () => {
          executorCalls.push(context);
          context.emit({ type: "delta", content: "oneshot with unusable chat support" });
          context.emit({ type: "completed" });
        },
        stop: async () => undefined,
      }),
    };
    const createInteractiveSession = vi.fn(() => ({
      reconfigure: vi.fn(),
      ensureAttached: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      detachIfStillExpired: vi.fn(async () => undefined),
      snapshot: () => ({
        runtimeState: {
          executionStyle: "interactive" as const,
          attachmentState: "idle" as const,
          attachmentGeneration: 1,
          capabilities: runtimeSessionCapabilities(),
        },
      }),
    }));
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", [], ["fresh"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: (context: AgentExecutionContext) => executorFactory.create(context),
        createInteractiveSession,
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      executorFactory,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });

    const chatId = hub.snapshot().activeChatId!;
    await hub.sendPrompt("Hello", chatId);
    const activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(createInteractiveSession).not.toHaveBeenCalled();
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toMatchObject({
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      prompt: "Hello",
    });
    expect(activeChat?.runtimeState).toBeUndefined();
    expect(activeChat?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Hello" }),
      expect.objectContaining({ role: "assistant", content: "oneshot with unusable chat support" }),
    ]);
  });

  test("reuses one Codex attachment for sequential prompts in the same chat", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-interactive-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });

    const chatId = hub.snapshot().activeChatId!;
    await hub.sendPrompt("First", chatId);
    await waitFor(() => hub.snapshot().chats.find((chat) => chat.id === chatId), (chat) => chat?.running === false);
    await hub.sendPrompt("Second", chatId);
    await waitFor(() => hub.snapshot().chats.find((chat) => chat.id === chatId), (chat) => chat?.running === false);

    const calls = (await readFile(fake.callsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string });
    expect(calls.filter((call) => call.method === "initialize")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
  });

  test("routes Claude chats through shared interactive sessions and reuses the same session id for follow-up prompts", async () => {
    const attachCalls: Array<{ modelId: string | undefined }> = [];
    const sent: string[] = [];
    let attached = false;
    let forwardEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "claude",
        surfaceSupport: [support("chat", ["interactive"], ["fresh", "resume-preferred", "resume-required"])],
        runtimeStateCodec: claudeRuntimeStateCodec,
        getCapabilities: () => ({
          ...interactiveChatCapabilities("claude"),
          resume: {
            supportsInProcessConversationResume: true,
            supportsResumeAfterDetach: true,
            supportsResumeAfterAppRestart: true,
            supportsTurnResume: false,
          },
        }),
        createOneShotExecutor: () => ({
          start: async () => {
            throw new Error("one-shot executor path should not run");
          },
          stop: async () => undefined,
        }),
        createInteractiveSession: (context: any) =>
          new ClaudeInteractiveSession(context, {
            capabilities: runtimeSessionCapabilities(),
            sdkInteractive: {
              isAttached: () => attached,
              attach: async (input) => {
                attached = true;
                attachCalls.push({ modelId: input.modelId });
                forwardEvent = input.onEvent as (event: { type: string; [key: string]: unknown }) => void;
              },
              sendUserMessage: async (content: string) => {
                sent.push(content);
                forwardEvent?.({
                  type: "runtime_conversation",
                  runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-1" } }),
                });
                forwardEvent?.({ type: "completed", content: `reply:${content}` });
              },
              interrupt: async () => undefined,
              detach: async () => {
                attached = false;
              },
            },
          }),
      } as any,
    ]);
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" }, undefined, runtimeDrivers);
    addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);
    const chatId = hub.snapshot().activeChatId!;
    hub.setChatAgent(chatId, "claude-agent");
    (hub as any).runtimes.set("claude", {
      id: "claude",
      label: "Claude",
      command: "claude",
      version: "test",
      available: true,
    });

    await hub.sendPrompt("first", chatId);
    let activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );
    expect(activeChat?.runtimeState).toMatchObject({
      executionStyle: "interactive",
      attachmentState: "idle",
    });
    expect(activeChat?.runtimeConversation).toMatchObject(runtimeConversation("claude", { native: { sessionId: "claude-session-1" } }));

    await hub.sendPrompt("second", chatId);
    activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(attachCalls).toHaveLength(1);
    expect(sent).toEqual(["first", "second"]);
    expect(activeChat?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "first" }),
      expect.objectContaining({ role: "assistant", content: "reply:first" }),
      expect.objectContaining({ role: "user", content: "second" }),
      expect.objectContaining({ role: "assistant", content: "reply:second" }),
    ]);
  });

  test("maps Claude interactive chat model ids through the channel-specific alias before SDK attach", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-interactive-model-"));
    const attachCalls: Array<{ modelId: string | undefined }> = [];
    let attached = false;
    let forwardEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    const channelPath = path.join(dir, "model-channels.json");
    const deepseekClaudeChannel: AgentChannel = {
      id: "claude-deepseek",
      agentId: "claude",
      label: "Claude DeepSeek",
      providerName: "DeepSeek",
      modelProvider: "deepseek-anthropic",
      baseUrl: "https://api.deepseek.test/anthropic",
      httpHeaders: { Authorization: "Bearer deepseek-key" },
      models: [
        { id: DEFAULT_MODEL_ID, label: "Default" },
        { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      ],
    };
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "claude",
        surfaceSupport: [support("chat", ["interactive"], ["fresh", "resume-preferred", "resume-required"])],
        runtimeStateCodec: claudeRuntimeStateCodec,
        getCapabilities: () => ({
          ...interactiveChatCapabilities("claude"),
          resume: {
            supportsInProcessConversationResume: true,
            supportsResumeAfterDetach: true,
            supportsResumeAfterAppRestart: true,
            supportsTurnResume: false,
          },
        }),
        createOneShotExecutor: () => ({
          start: async () => {
            throw new Error("one-shot executor path should not run");
          },
          stop: async () => undefined,
        }),
        createInteractiveSession: (context: any) =>
          new ClaudeInteractiveSession(context, {
            capabilities: runtimeSessionCapabilities(),
            resolveModelId: (interactiveContext) =>
              claudeCliModelForChannel(deepseekClaudeChannel, interactiveContext.runtimeConfig.model) ?? interactiveContext.runtimeConfig.model,
            sdkInteractive: {
              isAttached: () => attached,
              attach: async (input) => {
                attached = true;
                attachCalls.push({ modelId: input.modelId });
                forwardEvent = input.onEvent as (event: { type: string; [key: string]: unknown }) => void;
              },
              sendUserMessage: async (content: string) => {
                forwardEvent?.({
                  type: "runtime_conversation",
                  runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-1" } }),
                });
                forwardEvent?.({ type: "completed", content: `reply:${content}` });
              },
              interrupt: async () => undefined,
              detach: async () => {
                attached = false;
              },
            },
          }),
      } as any,
    ]);
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" }, undefined, runtimeDrivers);
    await hub.loadModelChannels(channelPath);
    await hub.saveModelChannels([deepseekClaudeChannel]);
    addConfiguredAgents(
      hub,
      [configuredAgent("claude-agent", {
        runtimeAgentId: "claude",
        name: "Claude Agent",
        channelId: "claude-deepseek",
        modelId: "deepseek-v4-flash",
      })],
    );
    const chatId = hub.createChat("claude-agent").id;
    (hub as any).runtimes.set("claude", {
      id: "claude",
      label: "Claude",
      command: "claude",
      version: "test",
      available: true,
    });

    await hub.sendPrompt("first", chatId);
    await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0]?.modelId).toBe(claudeCliModelForChannel(deepseekClaudeChannel, "deepseek-v4-flash"));
  });

  test("marks chat failed when interactive session creation throws", async () => {
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["interactive"], ["fresh", "resume-preferred", "resume-required"])],
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: () => ({
          start: async () => {
            throw new Error("one-shot executor path should not run");
          },
          stop: async () => undefined,
        }),
        createInteractiveSession: () => {
          throw new Error("interactive session unavailable");
        },
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      undefined,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });
    const chatId = hub.snapshot().activeChatId!;

    await hub.sendPrompt("Hello", chatId);
    const activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(activeChat?.lastError).toBe("interactive session unavailable");
    expect(activeChat?.messages.at(-1)).toMatchObject({
      role: "error",
      content: "interactive session unavailable",
    });
  });

  test("stopChat interrupts an in-flight interactive turn without waiting for the session queue to drain", async () => {
    let interactiveContext: any;
    let releasePrompt: (() => void) | undefined;
    let promptStarted = false;
    const sessionState: ChatRuntimeSessionState = {
      executionStyle: "interactive" as const,
      attachmentState: "idle" as const,
      attachmentGeneration: 1,
      capabilities: {
        supportsInProcessConversationResume: true,
        supportsResumeAfterDetach: false,
        supportsResumeAfterAppRestart: false,
        supportsTurnResume: false,
        supportsInterrupt: true,
        supportsContinue: true,
        supportsApprovalRequests: false,
        supportsUserInputRequests: false,
      },
    };
    const session = {
      reconfigure: vi.fn(),
      ensureAttached: vi.fn(async () => {
        sessionState.attachmentState = "idle";
      }),
      sendPrompt: vi.fn(async () => {
        promptStarted = true;
        interactiveContext.emit({
          type: "runtime_conversation",
          runtimeConversation: runtimeConversation("codex", { native: { threadId: "interactive-session-1" } }),
        });
        sessionState.attachmentState = "running";
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }),
      interrupt: vi.fn(async () => {
        sessionState.attachmentState = "interrupted";
        releasePrompt?.();
      }),
      detach: vi.fn(async () => undefined),
      detachIfStillExpired: vi.fn(async () => undefined),
      snapshot: () => ({ runtimeState: sessionState }),
    };
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["interactive"], ["fresh", "resume-preferred", "resume-required"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: () => ({
          start: async () => {
            throw new Error("driver one-shot path should not run");
          },
          stop: async () => undefined,
        }),
        createInteractiveSession: (context: any) => {
          interactiveContext = context;
          return session;
        },
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      undefined,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });
    const chatId = hub.snapshot().activeChatId!;

    const sendPromise = hub.sendPrompt("Hello", chatId);
    await waitFor(() => promptStarted, Boolean);

    const stopResult = await Promise.race([
      hub.stopChat(chatId).then(() => "stopped" as const),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 50)),
    ]);

    expect(stopResult).toBe("stopped");
    expect(session.interrupt).toHaveBeenCalledTimes(1);
    await sendPromise;

    const activeChat = hub.snapshot().chats.find((chat) => chat.id === chatId);
    expect(activeChat?.running).toBe(false);
    expect(activeChat?.messages.at(-1)).toMatchObject({
      role: "error",
      content: "Stopped",
    });
  });

  test("clears interactive runtime turn state when Codex turn/start fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-turn-failure-"));
    const fake = await writeTurnStartFailureCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });
    const chatId = hub.snapshot().activeChatId!;

    await hub.sendPrompt("Hello", chatId);

    const activeChat = await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );

    expect(activeChat?.lastError).toContain("turn/start: turn failed");
    expect(activeChat?.runtimeState?.attachmentState).toBe("idle");
    expect(activeChat?.runtimeState?.activeTurnId).toBeUndefined();
  });

  test("disposes interactive sessions and deletes chats when a runtime has no cleanup surface", async () => {
    const session = {
      reconfigure: vi.fn(),
      ensureAttached: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => {
        interactiveContext.emit({ type: "completed", content: "done" });
      }),
      interrupt: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      detachIfStillExpired: vi.fn(async () => undefined),
      snapshot: () => ({
        runtimeState: {
          executionStyle: "interactive" as const,
          attachmentState: "idle" as const,
          attachmentGeneration: 1,
          capabilities: {
            supportsInProcessConversationResume: true,
            supportsResumeAfterDetach: false,
            supportsResumeAfterAppRestart: false,
            supportsTurnResume: false,
            supportsInterrupt: true,
            supportsContinue: true,
            supportsApprovalRequests: false,
            supportsUserInputRequests: false,
          },
        },
      }),
    };
    let interactiveContext: any;
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [
          support("chat", ["interactive"], ["fresh", "resume-preferred", "resume-required"]),
        ],
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: () => ({
          start: async () => {
            throw new Error("driver one-shot path should not run");
          },
          stop: async () => undefined,
        }),
        createInteractiveSession: (context: any) => {
          interactiveContext = context;
          return session;
        },
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      undefined,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });
    const chatId = hub.snapshot().activeChatId!;

    await hub.sendPrompt("Hello", chatId);
    await waitFor(
      () => hub.snapshot().chats.find((chat) => chat.id === chatId),
      (chat) => chat?.running === false,
    );
    await hub.deleteChat(chatId);

    expect(session.detach).toHaveBeenCalledWith("app_shutdown");
    expect(hub.snapshot().chats.some((chat) => chat.id === chatId)).toBe(false);
  });

  test("deletes Codex sessions created while testing configured agents", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-test-"));
    const fake = await writeCodexExecFake(dir);
    const codexHomeDir = path.join(dir, "codex-home");
    const sessionDir = path.join(codexHomeDir, "sessions", "2026", "06", "29");
    const sessionPath = path.join(sessionDir, `rollout-2026-06-29T22-42-38-${fake.sessionId}.jsonl`);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, "{}\n", "utf8");
    vi.stubEnv("CODEX_HOME", codexHomeDir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });

    await hub.loadModelChannels(path.join(dir, "model-channels.json"));
    await hub.saveModelChannels([
      {
        id: "codex-volcengine",
        agentId: "codex",
        label: "Codex Volcengine",
        providerName: "Volcengine",
        modelProvider: "volcengine",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        wireApi: "responses",
        models: [
          { id: DEFAULT_MODEL_ID, label: "Default" },
          { id: "ep-m-user-owned-endpoint", label: "User endpoint" },
        ],
      },
    ]);
    (hub as any).chats.clear();
    hub.updateConfiguredAgents([
      {
        id: "doubao-agent",
        name: "Doubao Agent",
        description: "",
        runtimeAgentId: "codex",
        channelId: "codex-volcengine",
        modelId: "ep-m-user-owned-endpoint",
        tags: [],
        createdAt: 1710000000000,
        updatedAt: 1710000000000,
      },
    ]);

    try {
      const result = await hub.testConfiguredAgent("doubao-agent");

      expect(result.ok).toBe(true);
      const calls = (await readFile(fake.callsPath, "utf8"))
        .trim()
        .split(/\n/)
        .map((line) => JSON.parse(line) as { args: string[] });
      expect(calls.some((call) => call.args[0] === "exec" && call.args.some((arg) => arg.includes("ep-m-user-owned-endpoint")))).toBe(true);
      expect(calls).toContainEqual({ args: ["archive", fake.sessionId] });
      // The local rollout file for the test session must be deleted, not just archived.
      await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("passes runtimeConversation into driver cleanup when deleting a chat", async () => {
    const deleteSessionArtifacts = vi.fn(async () => undefined);
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [
          {
            surface: "cleanup",
            executionModes: ["oneshot"],
            continuationPolicies: ["fresh", "resume-preferred"],
          },
        ],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => oneshotChatCapabilities("codex"),
        createOneShotExecutor: () => ({
          start: async () => undefined,
          stop: async () => undefined,
        }),
        deleteSessionArtifacts,
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "missing-codex-for-test", claude: "missing-claude-for-test" },
      undefined,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });

    const chatId = hub.snapshot().activeChatId!;
    const chat = (hub as any).chats.get(chatId);
    chat.runtimeConversation = runtimeConversation("codex", { native: { threadId: "cleanup-thread-1" } });

    await hub.deleteChat(chatId);

    expect(deleteSessionArtifacts).toHaveBeenCalledWith({
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "cleanup-thread-1" } }),
      workDir: expect.any(String),
    });
  });

  test("tests Claude configured agents through the official SDK one-shot path without deleting local session files", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-sdk-test-home-"));
    const workDir = path.join(homeDir, "workspace");
    const sessionId = "019ed5a0-0000-7000-8000-000000000456";
    const projectSlug = workDir.replace(/[:\\/]/g, "-");
    const sessionDir = path.join(homeDir, ".claude", "projects", projectSlug);
    const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, "{}\n", "utf8");
    vi.stubEnv("HOME", homeDir);
    const runOneShot = vi.fn(async (input: any) => {
      input.onEvent({
        type: "runtime_conversation",
        runtimeConversation: runtimeConversation("claude", { native: { sessionId } }),
      });
      input.onEvent({ type: "delta", content: "SDK ok" });
      input.onEvent({ type: "completed", content: "SDK ok" });
    });
    const hub = createHubWithClaudeOneShot(runOneShot);
    await hub.loadModelChannels(path.join(homeDir, "claude-model-channels.json"));
    await hub.saveModelChannels([
      {
        id: "claude-deepseek",
        agentId: "claude",
        label: "Claude DeepSeek",
        providerName: "DeepSeek",
        modelProvider: "deepseek-anthropic",
        baseUrl: "https://api.deepseek.test/anthropic",
        httpHeaders: { Authorization: "Bearer deepseek-key" },
        models: [
          { id: DEFAULT_MODEL_ID, label: "Default" },
          { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
        ],
      },
    ]);
    hub.updateConfiguredAgents([
      configuredAgent("claude-agent", {
        runtimeAgentId: "claude",
        channelId: "claude-deepseek",
        modelId: "deepseek-v4-flash",
      }),
    ]);
    hub.setWorkDir(workDir);
    (hub as any).runtimes.set("claude", {
      id: "claude",
      label: "Claude",
      command: "claude",
      version: "test",
      available: true,
    });

    try {
      const result = await hub.testConfiguredAgent("claude-agent");

      expect(result.ok).toBe(true);
      expect(result.output).toBe("SDK ok");
      expect(runOneShot).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("OK"),
          cwd: workDir,
          modelId: "claude-haiku-4-5",
        }),
      );
      await expect(readFile(sessionPath, "utf8")).resolves.toBe("{}\n");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("queries a runtime channel balance from the stored channel config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-balance-"));
    const hub = new AgentHub();
    await hub.loadModelChannels(path.join(dir, "model-channels.json"));
    await hub.saveModelChannels([
      {
        id: "deepseek-api",
        agentId: "api",
        label: "DeepSeek API",
        providerName: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        httpHeaders: { Authorization: "Bearer sk-deepseek" },
        models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
      },
    ]);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "42" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await hub.queryRuntimeChannelBalance("deepseek-api", { fetch: fetchImpl, now: () => 1710000000000 });

    expect(result).toMatchObject({
      channelId: "deepseek-api",
      providerName: "DeepSeek",
      supported: true,
      status: "success",
      items: [{ label: "CNY", remaining: 42, unit: "CNY" }],
    });
  });

  test("starts with one unconfigured chat and only exposes Runtime Agents", () => {
    const hub = new AgentHubImplementation();
    const snapshot = hub.snapshot();
    const activeChat = snapshot.chats.find((chat) => chat.id === snapshot.activeChatId);

    expect(snapshot.chats).toHaveLength(1);
    expect(activeChat?.configuredAgentId).toBe("");
    expect(snapshot.configuredAgents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: TEST_CODEX_AGENT_ID, runtimeAgentId: "codex", channelId: "codex-openai" }),
    ]));
    expect(snapshot.configuredAgents.some((agent) => agent.id === "default-agent")).toBe(false);
  });

  test("creates isolated chats with their own agent provider", () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);

    const claudeChat = hub.createChat("claude-agent");
    const snapshot = hub.snapshot();
    const activeChat = snapshot.chats.find((chat) => chat.id === snapshot.activeChatId);

    expect(claudeChat.configuredAgentId).toBe("claude-agent");
    expect(snapshot.chats).toHaveLength(2);
    expect(activeChat?.id).toBe(claudeChat.id);
    expect(activeChat?.configuredAgentId).toBe("claude-agent");
  });

  test("deletes a chat session with its local messages and selects the next remaining chat", async () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    const firstChatId = hub.snapshot().activeChatId!;
    const secondChat = hub.createChat(TEST_CODEX_AGENT_ID);
    const firstChat = (hub as any).chats.get(firstChatId);
    firstChat.messages.push({ id: "m-1", role: "user", content: "Delete me", timestamp: 1710000000000 });
    hub.selectChat(firstChatId);

    const snapshot = await (hub as any).deleteChat(firstChatId);

    expect(snapshot.chats.map((chat: any) => chat.id)).toEqual([secondChat.id]);
    expect(snapshot.activeChatId).toBe(secondChat.id);
    expect(snapshot.chats.some((chat: any) => chat.id === firstChatId || chat.messages.some((message: any) => message.content === "Delete me"))).toBe(false);
  });

  test("archives the Codex session when deleting a chat with a session id", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-chat-archive-"));
    const argsPath = path.join(dir, "args.txt");
    const executable = await writeNodeCliLauncher(
      dir,
      "codex-fake",
      `const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, process.argv.slice(2).join("\\n") + "\\n", "utf8");
`,
    );

    const hub = new AgentHub({ codex: executable, claude: "missing-claude-for-test" });
    const chatId = hub.snapshot().activeChatId!;
    const chat = (hub as any).chats.get(chatId);
    chat.runtimeConversation = runtimeConversation("codex", {
      native: { threadId: "019e9143-2451-7612-a62d-e65389574d7d" },
    });

    const snapshot = await (hub as any).deleteChat(chatId);

    expect(snapshot.chats.some((item: any) => item.id === chatId)).toBe(false);
    expect(await readFile(argsPath, "utf8")).toBe("archive\n019e9143-2451-7612-a62d-e65389574d7d\n");
  });

  test("deletes the local Codex session file when archive fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-delete-fallback-"));
    const codexHomeDir = path.join(dir, "codex-home");
    const sessionId = "019e9143-2451-7612-a62d-e65389574d7d";
    const sessionDir = path.join(codexHomeDir, "sessions", "2026", "06", "29");
    const sessionPath = path.join(sessionDir, `rollout-2026-06-29T22-42-38-${sessionId}.jsonl`);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, "{}\n", "utf8");
    const executable = await writeNodeCliLauncher(dir, "codex-fake", "process.exit(1);\n");
    vi.stubEnv("CODEX_HOME", codexHomeDir);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const hub = new AgentHub({ codex: executable, claude: "missing-claude-for-test" });
      const chatId = hub.snapshot().activeChatId!;
      const chat = (hub as any).chats.get(chatId);
      chat.runtimeConversation = runtimeConversation("codex", { native: { threadId: sessionId } });

      await (hub as any).deleteChat(chatId);

      await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  test("flushes persisted state when deleting a chat", async () => {
    vi.useFakeTimers();
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-delete-persist-"));
      const storagePath = path.join(dir, "state.json");
      const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
      await hub.loadPersistedState(storagePath);
      const chatId = hub.snapshot().activeChatId!;

      await (hub as any).deleteChat(chatId);

      const persisted = JSON.parse(await readFile(storagePath, "utf8")) as { sessions?: Array<{ id: string }> };
      expect(persisted.sessions?.some((session) => session.id === chatId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("deletes the Claude session file when deleting a Claude chat", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-home-"));
    const workDir = path.join(homeDir, "workspace");
    const sessionId = "019e9143-2451-7612-a62d-e65389574d7d";
    const projectSlug = workDir.replace(/[:\\/]/g, "-");
    const sessionDir = path.join(homeDir, ".claude", "projects", projectSlug);
    const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, "{}\n", "utf8");
    vi.stubEnv("HOME", homeDir);
    try {
      const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
      addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);
      hub.setWorkDir(workDir);
      const chat = hub.createChat("claude-agent");
      const state = (hub as any).chats.get(chat.id);
      state.runtimeConversation = runtimeConversation("claude", { native: { sessionId } });

      await (hub as any).deleteChat(chat.id);

      await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("changes the active chat agent without affecting other chats", () => {
    const hub = new AgentHub();
    const firstChatId = hub.snapshot().activeChatId!;
    addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);
    const secondChat = hub.createChat("claude-agent");

    hub.setChatAgent(secondChat.id, TEST_CODEX_AGENT_ID);

    const snapshot = hub.snapshot();
    const firstChat = snapshot.chats.find((chat) => chat.id === firstChatId);
    const activeChat = snapshot.chats.find((chat) => chat.id === snapshot.activeChatId);

    expect(firstChat?.configuredAgentId).toBe(TEST_CODEX_AGENT_ID);
    expect(activeChat?.id).toBe(secondChat.id);
    expect(activeChat?.configuredAgentId).toBe(TEST_CODEX_AGENT_ID);
  });

  test("tracks the selected configured agent per chat before a conversation starts", () => {
    const hub = new AgentHub();
    addConfiguredAgents(hub, [
      configuredAgent("codex-gpt55", { name: "Codex GPT-5.5", modelId: "gpt-5.5" }),
      configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" }),
    ]);
    const chatId = hub.snapshot().activeChatId!;

    hub.setChatModel(chatId, "gpt-5.5");

    const activeChat = hub.snapshot().chats.find((chat) => chat.id === chatId);
    expect(activeChat?.configuredAgentId).toBe(TEST_CODEX_AGENT_ID);

    hub.setChatAgent(chatId, "claude-agent");

    const switchedChat = hub.snapshot().chats.find((chat) => chat.id === chatId);
    expect(switchedChat?.configuredAgentId).toBe("claude-agent");
  });

  test("uses the chat-selected model when sending a prompt", async () => {
    const contexts: AgentExecutionContext[] = [];
    const executorFactory: AgentExecutorFactory = {
      create: (context) => {
        contexts.push(context);
        return {
          start: async () => {
            context.emit({ type: "completed", content: "ok" });
          },
          stop: async () => undefined,
        };
      },
    };
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["oneshot"], ["fresh", "resume-preferred"])],
        getCapabilities: () => oneshotChatCapabilities("codex"),
        createOneShotExecutor: (context: AgentExecutionContext) => executorFactory.create(context),
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      executorFactory,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex-for-test",
      version: "test",
      available: true,
    });
    const chatId = hub.snapshot().activeChatId!;

    hub.setChatModel(chatId, "gpt-5.5");
    await hub.sendPrompt("Use the selected model", chatId);

    await waitFor(() => contexts, (items) => items.length === 1);
    expect(contexts[0]?.runtimeConfig?.model).toBe("gpt-5.5");
  });

  test("changes the selected channel before a conversation starts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-config-"));
    const hub = new AgentHub();
    await hub.loadModelChannels(path.join(dir, "model-channels.json"));
    await hub.saveModelChannels([
      {
        id: "codex-openai",
        agentId: "codex",
        label: "Codex OpenAI",
        models: [
          { id: DEFAULT_MODEL_ID, label: "Default" },
          { id: "gpt-5.5", label: "GPT-5.5" },
        ],
      },
      {
        id: "codex-bridge",
        agentId: "codex",
        label: "Codex Bridge",
        models: [
          { id: DEFAULT_MODEL_ID, label: "Default" },
          { id: "gpt-5.4", label: "GPT-5.4" },
        ],
      },
    ]);
    const chatId = hub.snapshot().activeChatId!;

    hub.setChatChannel(chatId, "codex-bridge");
    hub.setChatModel(chatId, "gpt-5.4");

    const activeChat = hub.snapshot().chats.find((chat) => chat.id === chatId);
    expect(activeChat?.configuredAgentId).toBe(TEST_CODEX_AGENT_ID);
  });

  test("setChatChannel stores a same-runtime channel override even after the first prompt", async () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    (hub as any).channels = [
      {
        id: "codex-openai",
        agentId: "codex",
        label: "Codex OpenAI",
        models: [{ id: "default", label: "Default" }, { id: "gpt-5.5", label: "GPT-5.5" }],
      },
      {
        id: "codex-openrouter",
        agentId: "codex",
        label: "Codex OpenRouter",
        models: [{ id: "default", label: "Default" }, { id: "gpt-5.5", label: "GPT-5.5" }],
      },
    ];

    const chat = hub.createChat(TEST_CODEX_AGENT_ID);
    const raw = (hub as any).chats.get(chat.id);
    raw.messages.push({ id: "m-1", role: "user", content: "hello", timestamp: 1 });

    hub.setChatChannel(chat.id, "codex-openrouter");

    expect(hub.snapshot().chats.find((item) => item.id === chat.id)).toMatchObject({
      id: chat.id,
      channelId: "codex-openrouter",
    });
  });

  test("setChatModel updates the stored model after chat history exists", () => {
    const hub = createHubWithTwoCodexChannels();
    const chat = hub.createChat(TEST_CODEX_AGENT_ID);
    const raw = (hub as any).chats.get(chat.id);
    raw.messages.push({ id: "m-1", role: "assistant", content: "hello", timestamp: 1 });

    hub.setChatModel(chat.id, "gpt-5.5");

    expect(hub.snapshot().chats.find((item) => item.id === chat.id)?.modelId).toBe("gpt-5.5");
  });

  test("allows chat configuration changes after a conversation has started", () => {
    const hub = new AgentHub();
    addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);
    const chatId = hub.snapshot().activeChatId!;
    const chat = (hub as any).chats.get(chatId);

    (hub as any).handleAgentEvent(chat, { type: "delta", content: "Started" });

    hub.setChatAgent(chatId, "claude-agent");
    hub.setChatChannel(chatId, "claude-code");
    hub.setChatModel(chatId, "gpt-5.5");

    const activeChat = hub.snapshot().chats.find((item) => item.id === chatId);
    expect(activeChat?.configuredAgentId).toBe("claude-agent");
  });

  test("setChatAgent clears the old native handle when the runtime family changes", () => {
    const hub = createHubWithCodexAndClaudeAgents();
    const chat = hub.createChat("codex-agent");
    const raw = (hub as any).chats.get(chat.id);
    raw.runtimeState = {
      executionStyle: "interactive",
      attachmentState: "idle",
      attachmentGeneration: 1,
      capabilities: runtimeSessionCapabilities(),
    };
    raw.runtimeConversation = runtimeConversation("codex", { native: { threadId: "thread-1" } });
    raw.messages.push({ id: "m-1", role: "assistant", content: "hello", timestamp: 1 });

    hub.setChatAgent(chat.id, "claude-agent");

    expect(hub.snapshot().chats.find((item) => item.id === chat.id)).toMatchObject({
      configuredAgentId: "claude-agent",
    });
    expect(hub.snapshot().chats.find((item) => item.id === chat.id)?.runtimeConversation).toBeUndefined();
  });

  test("stores runtime conversations without adding transcript messages", () => {
    const hub = new AgentHub();
    const chatId = hub.snapshot().activeChatId!;
    const chat = (hub as any).chats.get(chatId);

    (hub as any).handleAgentEvent(chat, {
      type: "runtime_conversation",
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "session-123" } }),
    });

    const activeChat = hub.snapshot().chats.find((item) => item.id === chatId);
    expect(activeChat?.runtimeConversation).toEqual(runtimeConversation("codex", { native: { threadId: "session-123" } }));
    expect(activeChat?.messages).toEqual([]);
  });

  test("clears stale runtimeConversation after identity-breaking interactive reconfigure fails before a new conversation is emitted", async () => {
    let interactiveContext: any;
    let currentConversation: RuntimeConversation | undefined;
    let currentWorkDir = "C:/repo";
    let sendCount = 0;
    const sessionState: ChatRuntimeSessionState = {
      executionStyle: "interactive",
      attachmentState: "idle",
      attachmentGeneration: 1,
      capabilities: runtimeSessionCapabilities(),
    };
    const session = {
      reconfigure: vi.fn((context: any) => {
        if (context.workDir !== currentWorkDir) {
          currentWorkDir = context.workDir;
          currentConversation = undefined;
        }
      }),
      ensureAttached: vi.fn(async () => {
        sessionState.attachmentState = "idle";
      }),
      sendPrompt: vi.fn(async () => {
        sendCount += 1;
        if (sendCount === 1) {
          currentConversation = runtimeConversation("codex", { native: { threadId: "interactive-session-1" } });
          interactiveContext.emit({
            type: "runtime_conversation",
            runtimeConversation: currentConversation,
          });
          interactiveContext.emit({ type: "completed", content: "First reply" });
          return;
        }
        throw new Error("turn/start: turn failed");
      }),
      interrupt: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      detachIfStillExpired: vi.fn(async () => undefined),
      snapshot: () => ({
        runtimeState: sessionState,
        ...(currentConversation ? { runtimeConversation: currentConversation } : {}),
      }),
    };
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("chat", ["interactive"], ["fresh", "resume-preferred", "resume-required"])],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => interactiveChatCapabilities("codex"),
        createOneShotExecutor: () => ({
          start: async () => {
            throw new Error("driver one-shot path should not run");
          },
          stop: async () => undefined,
        }),
        createInteractiveSession: (context: any) => {
          interactiveContext = context;
          currentWorkDir = context.workDir;
          return session;
        },
      } as any,
    ]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      undefined,
      runtimeDrivers,
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex",
      version: "test",
      available: true,
    });
    const chatId = hub.snapshot().activeChatId!;

    await hub.sendPrompt("Hello", chatId);
    expect(hub.snapshot().chats.find((item) => item.id === chatId)?.runtimeConversation).toEqual(
      runtimeConversation("codex", { native: { threadId: "interactive-session-1" } }),
    );

    hub.setWorkDir("C:/other-repo");
    await hub.sendPrompt("Retry", chatId);

    expect(hub.snapshot().chats.find((item) => item.id === chatId)?.runtimeConversation).toBeUndefined();
  });

  test("restoreChatState keeps a stored channel override only when it still matches the configured runtime", () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    const restored = (hub as any).restoreChatState({
      id: "chat-1",
      title: "Chat",
      configuredAgentId: TEST_CODEX_AGENT_ID,
      channelId: "codex-openai",
      modelId: "default",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });

    expect(restored?.channelId).toBe("codex-openai");
  });

  test("does not append final completed content after streamed assistant text", () => {
    const hub = new AgentHub();
    const chatId = hub.snapshot().activeChatId!;
    const chat = (hub as any).chats.get(chatId);

    (hub as any).handleAgentEvent(chat, { type: "delta", content: "Hello" });
    (hub as any).handleAgentEvent(chat, { type: "completed", content: "Hello" });

    const activeChat = hub.snapshot().chats.find((item) => item.id === chatId);
    expect(activeChat?.messages).toHaveLength(1);
    expect(activeChat?.messages[0]).toMatchObject({ role: "assistant", content: "Hello" });
  });

  test("shows meta events between assistant message segments", () => {
    const hub = new AgentHub();
    const chatId = hub.snapshot().activeChatId!;
    const chat = (hub as any).chats.get(chatId);

    (hub as any).handleAgentEvent(chat, { type: "delta", content: "I will inspect files." });
    (hub as any).handleAgentEvent(chat, { type: "meta", content: "鈫?shell_command\nls" });
    (hub as any).handleAgentEvent(chat, { type: "delta", content: "Found the files." });

    const activeChat = hub.snapshot().chats.find((item) => item.id === chatId);
    expect(activeChat?.messages).toHaveLength(1);
    expect(activeChat?.messages[0]).toMatchObject({
      role: "assistant",
      content: "I will inspect files.Found the files.",
      events: [expect.objectContaining({ type: "meta", content: "鈫?shell_command\nls" })],
    });
  });

  test("stores approval request and response pairs and resolves the pending request", () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    const chat = (hub as any).createChatState(TEST_CODEX_AGENT_ID);

    (hub as any).handleAgentEvent(chat, {
      type: "approval_request",
      requestId: "approval-1",
      content: "Allow Bash?",
    });
    (hub as any).handleAgentEvent(chat, {
      type: "approval_response",
      requestId: "approval-1",
      decision: "approved",
      content: "Allowed",
    });

    const assistant = chat.messages.find((message: { role: string }) => message.role === "assistant");
    expect(assistant?.events).toEqual([
      expect.objectContaining({
        type: "approval_request",
        requestId: "approval-1",
        requestState: "resolved",
      }),
      expect.objectContaining({
        type: "approval_response",
        requestId: "approval-1",
        decision: "approved",
      }),
    ]);
  });

  test("reads Codex status through app-server RPC without starting an agent conversation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-status-"));
    const fake = await writeCodexAppServerFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);
    const chatId = hub.snapshot().activeChatId!;
    ((hub as any).chats.get(chatId) as { runtimeConversation?: ReturnType<typeof runtimeConversation> }).runtimeConversation =
      runtimeConversation("codex", { native: { threadId: "status-thread-1" } });

    await hub.sendPrompt("/status", chatId);
    hub.setChatAgent(chatId, "claude-agent");

    const activeChat = hub.snapshot().chats.find((item) => item.id === chatId);
    expect(activeChat?.configuredAgentId).toBe("claude-agent");
    expect(activeChat?.running).toBe(false);
    expect(activeChat?.lastError).toBeUndefined();
    expect(activeChat?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "/status", local: true }),
      expect.objectContaining({
        role: "assistant",
        local: true,
        content: expect.stringContaining("Codex app-server status"),
      }),
    ]);
    expect(activeChat?.messages.at(-1)?.content).toContain("Model: gpt-5.5");
    expect(activeChat?.messages.at(-1)?.content).toContain("Provider: openai");
    expect(activeChat?.messages.at(-1)?.content).toContain("Approval: never");
    expect(activeChat?.messages.at(-1)?.content).toContain("Sandbox: danger-full-access");
    expect(activeChat?.messages.at(-1)?.content).toContain("Plugins: 3 total, 1 enabled, 2 installed");
    expect(activeChat?.messages.at(-1)?.content).toContain("MCP servers: 1");

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params?: any });
    expect(calls.map((call) => call.method)).toEqual(
      expect.arrayContaining(["initialize", "config/read", "model/list", "plugin/list", "mcpServerStatus/list"]),
    );
    expect(calls.map((call) => call.method)).not.toContain("turn/start");
    expect(calls.find((call) => call.method === "mcpServerStatus/list")?.params?.threadId ?? null).toBeNull();
  });

  test("lists the full Codex plugin catalog through app-server RPC", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-plugin-list-"));
    const fake = await writeCodexAppServerFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    const chatId = hub.snapshot().activeChatId!;

    await hub.sendPrompt("/plugins", chatId);

    const activeChat = hub.snapshot().chats.find((item) => item.id === chatId);
    expect(activeChat?.running).toBe(false);
    expect(activeChat?.messages.at(-1)).toMatchObject({
      role: "assistant",
      local: true,
      content: expect.stringContaining("documents@openai-primary-runtime"),
    });
    expect(activeChat?.messages.at(-1)?.content).toContain("spreadsheets@openai-primary-runtime");
    expect(activeChat?.messages.at(-1)?.content).toContain("github@openai-curated");
    expect(activeChat?.messages.at(-1)?.content).toContain("3 total");
    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string });
    expect(calls.map((call) => call.method)).toContain("plugin/list");
  });

  test("loads Codex plugin catalog for channel configuration without starting a conversation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-plugin-catalog-"));
    const fake = await writeCodexAppServerFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });

    const catalog = await hub.listCodexPluginCatalog();

    expect(catalog).toEqual([
      {
        id: "documents@openai-primary-runtime",
        name: "documents",
        marketplace: "openai-primary-runtime",
        installed: true,
        enabled: true,
        version: "1.0.0",
      },
      {
        id: "spreadsheets@openai-primary-runtime",
        name: "spreadsheets",
        marketplace: "openai-primary-runtime",
        installed: true,
        enabled: false,
        version: "1.0.0",
      },
      {
        id: "github@openai-curated",
        name: "github",
        marketplace: "openai-curated",
        installed: false,
        enabled: false,
      },
    ]);

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string });
    expect(calls.map((call) => call.method)).toEqual(expect.arrayContaining(["initialize", "plugin/list"]));
    expect(calls.map((call) => call.method)).not.toContain("turn/start");
  });

  test("refuses to load the Codex plugin catalog when the Codex runtime is unavailable", async () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    (hub as unknown as { runtimes: Map<string, unknown> }).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "missing-codex-for-test",
      version: null,
      available: false,
      error: "spawn missing-codex-for-test ENOENT",
    });

    await expect(hub.listCodexPluginCatalog()).rejects.toThrow("Codex CLI unavailable: spawn missing-codex-for-test ENOENT");
  });

  test("lists Codex models through app-server RPC", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-model-list-"));
    const fake = await writeCodexAppServerFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    const chatId = hub.snapshot().activeChatId!;

    await hub.sendPrompt("/models", chatId);

    const activeChat = hub.snapshot().chats.find((item) => item.id === chatId);
    expect(activeChat?.messages.at(-1)).toMatchObject({
      role: "assistant",
      local: true,
      content: expect.stringContaining("GPT-6 Preview"),
    });
    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string });
    expect(calls.map((call) => call.method)).toContain("model/list");
  });

  test("asks a configured Agent through Codex without creating a visible chat", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-oneshot-agent-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });
    const before = hub.snapshot();

    const events: any[] = [];
    const response = await (hub as any).askConfiguredAgent({
      requestId: "oneshot-test",
      prompt: "You are a Loop Engineering Agent. Ask one question.",
      configuredAgentId: TEST_CODEX_AGENT_ID,
      workDir: dir,
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
    }, (event: any) => events.push(event));

    expect(response).toEqual({
      content: "artifact-1",
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-1" } }),
      executionReference: { sessionId: "thread-1", turnId: "turn-1" },
    });
    expect(events).toEqual([
      { requestId: "oneshot-test", type: "delta", content: "artifact-1", invocationId: expect.any(String) },
      {
        requestId: "oneshot-test",
        type: "completed",
        content: "artifact-1",
        invocationId: expect.any(String),
        runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-1" } }),
      },
    ]);
    const after = hub.snapshot();
    expect(after.chats).toHaveLength(before.chats.length);

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    expect(calls.some((call) => call.method === "turn/start" && call.params.input[0].text.includes("Loop Engineering Agent"))).toBe(true);
  });

  test("injects only the custom MCP servers bound to the selected Codex Agent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-bound-mcp-codex-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", { id: "codex", label: "Codex", command: fake.executable, version: "test", available: true });
    hub.setMcpServers([
      { id: "bound", name: "Bound", transport: "stdio", command: "node", args: ["bound.js"], env: {}, enabled: true, tools: [], status: "connected", createdAt: 1, updatedAt: 1 },
      { id: "unbound", name: "Unbound", transport: "stdio", command: "node", args: ["unbound.js"], env: {}, enabled: true, tools: [], status: "connected", createdAt: 1, updatedAt: 1 },
    ]);
    hub.updateConfiguredAgents(hub.snapshot().configuredAgents.map((agent) => agent.id === TEST_CODEX_AGENT_ID
      ? { ...agent, mcpBindings: [{ serverId: "bound", toolAllowlist: [] }] }
      : agent));

    await hub.askConfiguredAgent({
      invocation: { surface: "agent" },
      requestId: "bound-mcp-codex",
      prompt: "Use the bound server.",
      configuredAgentId: TEST_CODEX_AGENT_ID,
      workDir: dir,
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
    });

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    const argv = (calls.find((call) => call.method === "process/argv")?.params.args as string[]).join("\n");
    expect(argv).toContain("bound.js");
    expect(argv).not.toContain("unbound.js");
  });

  test("asks a Claude configured Agent through the official SDK one-shot path without resuming when continuationPolicy is fresh", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-oneshot-sdk-"));
    const runOneShot = vi.fn(async (input: any) => {
      input.onEvent({
        type: "runtime_conversation",
        runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-7" } }),
      });
      input.onEvent({ type: "delta", content: "oneshot-sdk" });
      input.onEvent({ type: "completed", content: "oneshot-sdk" });
    });
    const hub = createHubWithClaudeOneShot(runOneShot);
    addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);
    (hub as any).runtimes.set("claude", {
      id: "claude",
      label: "Claude",
      command: "claude",
      version: "test",
      available: true,
    });

    const events: any[] = [];
    const response = await (hub as any).askConfiguredAgent(
      {
        requestId: "claude-oneshot-test",
        prompt: "Plan the repo",
        configuredAgentId: "claude-agent",
        workDir: dir,
        runtimeId: "claude",
        executionMode: "oneshot",
        continuationPolicy: "fresh",
        runtimeConfig: { model: DEFAULT_MODEL_ID },
        runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-old" } }),
      },
      (event: any) => events.push(event),
    );

    expect(response).toEqual({
      content: "oneshot-sdk",
      runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-7" } }),
      executionReference: { sessionId: "claude-session-7" },
    });
    expect(events).toEqual([
      { requestId: "claude-oneshot-test", type: "delta", content: "oneshot-sdk", invocationId: expect.any(String) },
      {
        requestId: "claude-oneshot-test",
        type: "completed",
        content: "oneshot-sdk",
        invocationId: expect.any(String),
        runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-7" } }),
      },
    ]);
    const oneShotInput = runOneShot.mock.calls[0]?.[0];
    expect(oneShotInput).toMatchObject({
      prompt: "Plan the repo",
      cwd: dir,
    });
    expect(oneShotInput?.resumeSessionId).toBeUndefined();
  });

  test("resumes a Claude configured Agent through the official SDK one-shot path when continuationPolicy is resume-preferred", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-oneshot-sdk-resume-"));
    const runOneShot = vi.fn(async (input: any) => {
      input.onEvent({ type: "delta", content: "oneshot-resumed" });
      input.onEvent({ type: "completed", content: "oneshot-resumed" });
    });
    const hub = createHubWithClaudeOneShot(runOneShot);
    addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);
    (hub as any).runtimes.set("claude", {
      id: "claude",
      label: "Claude",
      command: "claude",
      version: "test",
      available: true,
    });

    const priorConversation = runtimeConversation("claude", { native: { sessionId: "claude-session-9" } });
    const response = await (hub as any).askConfiguredAgent({
      requestId: "claude-oneshot-resume-test",
      prompt: "Continue the repo plan",
      configuredAgentId: "claude-agent",
      workDir: dir,
      runtimeId: "claude",
      executionMode: "oneshot",
      continuationPolicy: "resume-preferred",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      runtimeConversation: priorConversation,
    });

    expect(response).toEqual({
      content: "oneshot-resumed",
      runtimeConversation: priorConversation,
      executionReference: { sessionId: "claude-session-9" },
    });
    const oneShotInput = runOneShot.mock.calls[0]?.[0];
    expect(oneShotInput).toMatchObject({
      prompt: "Continue the repo plan",
      cwd: dir,
      resumeSessionId: "claude-session-9",
    });
  });

  test("starts a fresh one-shot run when the request explicitly chooses fresh despite carrying runtimeConversation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-oneshot-agent-fresh-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });

    const response = await (hub as any).askConfiguredAgent({
      requestId: "oneshot-fresh-test",
      prompt: "Start fresh from the updated spec.",
      configuredAgentId: TEST_CODEX_AGENT_ID,
      workDir: dir,
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-old" } }),
    });

    expect(response).toEqual({
      content: "artifact-1",
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-1" } }),
      executionReference: { sessionId: "thread-1", turnId: "turn-1" },
    });

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(0);
  });

  test("resumes a one-shot run only when the request explicitly chooses resume-preferred", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-oneshot-agent-resume-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });

    const response = await (hub as any).askConfiguredAgent({
      requestId: "oneshot-resume-test",
      prompt: "Continue from the prior turn.",
      configuredAgentId: TEST_CODEX_AGENT_ID,
      workDir: dir,
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "resume-preferred",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-7" } }),
    });

    expect(response).toEqual({
      content: "artifact-1",
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-7" } }),
      executionReference: { sessionId: "thread-7", turnId: "turn-1" },
    });

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "thread/resume" && call.params.threadId === "thread-7")).toHaveLength(1);
  });

  test("uses the request-selected model for API one-shot requests", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-oneshot-model-"));
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    await hub.loadModelChannels(path.join(dir, "model-channels.json"));
    await hub.saveModelChannels([
      {
        id: "deepseek-api",
        agentId: "api",
        label: "DeepSeek API",
        baseUrl: "https://api.deepseek.test/v1",
        models: [
          { id: DEFAULT_MODEL_ID, label: "Default" },
          { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
          { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
        ],
      },
    ]);
    hub.updateConfiguredAgents([
      configuredAgent("api-agent", {
        runtimeAgentId: "api",
        channelId: "deepseek-api",
        modelId: "deepseek-v4-flash",
      }),
    ]);
    (hub as any).runtimes.set("api", {
      id: "api",
      label: "API",
      command: "api",
      version: "test",
      available: true,
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: "oneshot-ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await (hub as any).askConfiguredAgent({
      prompt: "Use the selected model.",
      configuredAgentId: "api-agent",
      modelId: "deepseek-v4-pro",
      runtimeId: "api",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "deepseek-v4-pro" },
    });

    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      model: "deepseek-v4-pro",
    });
    vi.unstubAllGlobals();
  });

  test("persists and restores app-owned chat history", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-"));
    const storagePath = path.join(dir, "app-chats.json");
    const hub = new AgentHub();

    await hub.loadPersistedState(storagePath);
    hub.setWorkDir("/tmp/project");
    addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);
    const chat = hub.createChat("claude-agent");
    const chatState = (hub as any).chats.get(chat.id);
    (hub as any).handleAgentEvent(chatState, { type: "meta", content: "鈫?shell_command\npwd" });
    (hub as any).handleAgentEvent(chatState, { type: "delta", content: "Saved response" });
    (hub as any).handleAgentEvent(chatState, { type: "completed" });
    await hub.flushPersistence();

    const persisted = JSON.parse(await readFile(storagePath, "utf8")) as any;
    expect(persisted.version).toBe(5);
    expect(persisted.sessions).toEqual([expect.objectContaining({ id: expect.any(String) }), expect.objectContaining({ id: chat.id })]);
    expect(persisted.messages).toEqual(expect.arrayContaining([expect.objectContaining({ chatId: chat.id, role: "assistant" })]));
    expect(persisted.events).toEqual(expect.arrayContaining([expect.objectContaining({ chatId: chat.id, type: "meta", content: "鈫?shell_command\npwd" })]));

    const restored = new AgentHub();
    await restored.loadPersistedState(storagePath);
    const snapshot = restored.snapshot();
    const restoredChat = snapshot.chats.find((item) => item.id === chat.id);

    expect(snapshot.workDir).toBe("/tmp/project");
    expect(snapshot.activeChatId).toBe(chat.id);
    expect(restoredChat?.configuredAgentId).toBe("claude-agent");
    expect(restoredChat?.running).toBe(false);
    expect(restoredChat?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Saved response",
        events: [expect.objectContaining({ type: "meta", content: "鈫?shell_command\npwd" })],
      }),
    ]);
  });

  test("serializes a shutdown flush behind a failed in-flight persistence", async () => {
    let rejectFirstSave: ((error: Error) => void) | undefined;
    const firstSave = new Promise<void>((_resolve, reject) => {
      rejectFirstSave = reject;
    });
    const save = vi.fn(async (payload: PersistedAppStateV5) => {
      if (save.mock.calls.length === 1) await firstSave;
      expect(payload.version).toBe(5);
    });
    const store: AgentHubPersistedStore = {
      label: "test store",
      load: async () => ({
        version: 5,
        activeChatId: null,
        workDir: "",
        sessions: [],
        messages: [],
        events: [],
        tasks: [],
        taskMessages: [],
        taskEvents: [],
        channels: [],
      } satisfies PersistedAppStateV5),
      save,
      close: () => undefined,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hub = new AgentHub();
    await hub.loadPersistedState(store);

    hub.setWorkDir("/tmp/first");
    const firstFlush = hub.flushPersistence();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    hub.setWorkDir("/tmp/latest");
    const shutdownFlush = hub.flushPersistence();
    rejectFirstSave?.(new Error("connection stopped during save"));

    await expect(firstFlush).resolves.toBeUndefined();
    await expect(shutdownFlush).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0].workDir).toBe("/tmp/latest");
    warn.mockRestore();
  });

  test("restores a payload containing legacy Agent Team data and drops it on the next save", async () => {
    const save = vi.fn(async (_payload: PersistedAppStateV5) => undefined);
    const store: AgentHubPersistedStore = {
      label: "test store",
      load: async () => ({
        version: 5,
        activeChatId: "chat-1",
        activeTeamId: "team-1",
        activeTeamRunId: "team-run-1",
        workDir: "/tmp/project",
        sessions: [{
          id: "chat-1",
          title: "Kept chat",
          configuredAgentId: TEST_CODEX_AGENT_ID,
          lastError: undefined,
          createdAt: 1710000000000,
          updatedAt: 1710000000000,
        }],
        messages: [],
        events: [],
        tasks: [],
        taskMessages: [],
        taskEvents: [],
        teams: [{ id: "team-1", name: "Legacy team", mode: "supervisor", sharedContext: "", members: [] }],
        teamRuns: [{ id: "team-run-1", teamId: "team-1", mode: "pipeline", status: "running", steps: [] }],
        channels: [],
      }),
      save,
      close: () => undefined,
    };
    const hub = new AgentHub();
    await hub.loadPersistedState(store);

    expect(hub.snapshot().chats.map((chat) => chat.id)).toEqual(["chat-1"]);
    expect(hub.snapshot()).not.toHaveProperty("teams");

    hub.setWorkDir("/tmp/next");
    await hub.flushPersistence();

    const saved = save.mock.calls.at(-1)?.[0];
    expect(saved).toMatchObject({ version: 5, workDir: "/tmp/next" });
    // Older builds still require these arrays, so the legacy records are dropped but the fields stay empty.
    expect(saved).toMatchObject({ teams: [], teamRuns: [], activeTeamId: null, activeTeamRunId: null });
  });

  test("skips persistence errors that only signal store shutdown", async () => {
    const save = vi.fn(async () => {
      throw Object.assign(
        new Error("terminating connection due to administrator command"),
        { code: "57P01" },
      );
    });
    const store: AgentHubPersistedStore = {
      label: "test store",
      load: async () => undefined,
      save,
      close: () => undefined,
      isShutdownError: () => true,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hub = new AgentHub();
    await hub.loadPersistedState(store);

    await expect(hub.flushPersistence()).resolves.toBeUndefined();
    await expect(hub.shutdown()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist app state"),
      expect.anything(),
    );
    warn.mockRestore();
  });

  test("still reports persistence errors unrelated to shutdown", async () => {
    const save = vi.fn(async () => {
      throw new Error("disk full");
    });
    const store: AgentHubPersistedStore = {
      label: "test store",
      load: async () => undefined,
      save,
      close: () => undefined,
      isShutdownError: () => false,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hub = new AgentHub();
    await hub.loadPersistedState(store);

    await expect(hub.flushPersistence()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Failed to persist app state to test store:",
      expect.objectContaining({ message: "disk full" }),
    );
    warn.mockRestore();
  });

  test("discards persisted state when the file uses a legacy schema version", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-runtime-session-discard-"));
    const storagePath = path.join(dir, "app-chats.json");
    await writeFile(
      storagePath,
      JSON.stringify({
        version: 2,
        activeChatId: "chat-1",
        workDir: dir,
        sessions: [
          {
            id: "chat-1",
            title: "Legacy chat",
            configuredAgentId: TEST_CODEX_AGENT_ID,
            modelId: DEFAULT_MODEL_ID,
            sessionId: "thread-1",
            createdAt: 1710000000000,
            updatedAt: 1710000000000,
          },
        ],
        messages: [],
        events: [],
        tasks: [],
        taskMessages: [],
        taskEvents: [],
      }),
      "utf8",
    );

    const hub = new AgentHub();
    await hub.loadPersistedState(storagePath);

    const snapshot = hub.snapshot();
    expect(snapshot.chats.some((item) => item.id === "chat-1")).toBe(false);
    expect(snapshot.chats).toHaveLength(1);
    expect(snapshot.activeChatId).not.toBe("chat-1");
    expect(snapshot.workDir).not.toBe(dir);
  });

  test("restores interactive chats as detached and clears ephemeral turn state", () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);

    const restored = (hub as any).restoreChatState({
      id: "chat-restore-1",
      title: "Claude restore",
      configuredAgentId: "claude-agent",
      modelId: DEFAULT_MODEL_ID,
      runtimeState: {
        executionStyle: "interactive",
        attachmentState: "running",
        attachmentGeneration: 12,
        activeTurnId: "turn-9",
        lastMeaningfulActivityAt: 1710000000200,
        capabilities: runtimeSessionCapabilities(),
      },
      runtimeConversation: {
        runtimeId: "claude",
        codecVersion: "v1",
        payload: {
          native: { sessionId: "session-1" },
        },
      },
      messages: [],
      createdAt: 1710000000000,
      updatedAt: 1710000000000,
    });

    expect(restored.runtimeState).toMatchObject({
      executionStyle: "interactive",
      attachmentState: "detached",
      attachmentGeneration: 0,
      lastMeaningfulActivityAt: 1710000000200,
      capabilities: runtimeSessionCapabilities(),
    });
    expect(restored.runtimeState?.activeTurnId).toBeUndefined();
    expect(restored.runtimeConversation).toEqual(runtimeConversation("claude", { native: { sessionId: "session-1" } }));
  });

  test("discards persisted state when a version-4 record still uses legacy runtime fields", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-runtime-session-fallback-"));
    const storagePath = path.join(dir, "app-chats.json");
    await writeFile(
      storagePath,
      JSON.stringify({
        version: 5,
        activeChatId: "chat-1",
        workDir: dir,
        sessions: [
          {
            id: "chat-1",
            title: "Broken runtime session",
            configuredAgentId: TEST_CODEX_AGENT_ID,
            modelId: DEFAULT_MODEL_ID,
            runtimeSession: {
              executionStyle: "interactive",
            },
            createdAt: 1710000000000,
            updatedAt: 1710000000000,
          },
        ],
        messages: [],
        events: [],
        tasks: [],
        taskMessages: [],
        taskEvents: [],
      }),
      "utf8",
    );

    const hub = new AgentHub();
    await hub.loadPersistedState(storagePath);

    const snapshot = hub.snapshot();
    expect(snapshot.chats.some((item) => item.id === "chat-1")).toBe(false);
    expect(snapshot.chats).toHaveLength(1);
  });

  test("persists runtimeState as V5 and restores durable fields while clearing ephemeral state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-runtime-session-roundtrip-"));
    const storagePath = path.join(dir, "app-chats.json");
    const hub = new AgentHub();
    await hub.loadPersistedState(storagePath);
    const chat = hub.createChat(TEST_CODEX_AGENT_ID);
    const state = (hub as any).chats.get(chat.id);
    state.runtimeState = {
      executionStyle: "interactive",
      attachmentState: "running",
      attachmentGeneration: 7,
      activeTurnId: "turn-7",
      lastMeaningfulActivityAt: 1710000000500,
      capabilities: {
        supportsInProcessConversationResume: true,
        supportsResumeAfterDetach: true,
        supportsResumeAfterAppRestart: true,
        supportsTurnResume: false,
        supportsInterrupt: true,
        supportsContinue: true,
        supportsApprovalRequests: true,
        supportsUserInputRequests: true,
      },
    };
    state.runtimeConversation = runtimeConversation("codex", {
      native: { threadId: "thread-roundtrip-1", sessionTreeRootId: "tree-root-1" },
      appContext: {
        cwd: dir,
        modelId: DEFAULT_MODEL_ID,
        approvalPolicy: "never",
        sandboxPolicy: { mode: "workspace-write" },
      },
      extensions: { source: "test" },
    });

    await hub.flushPersistence();

    const persisted = JSON.parse(await readFile(storagePath, "utf8")) as any;
    expect(persisted.version).toBe(5);
    expect(persisted.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: chat.id,
          runtimeState: expect.objectContaining({
            executionStyle: "interactive",
            attachmentState: "running",
            attachmentGeneration: 7,
            activeTurnId: "turn-7",
          }),
          runtimeConversation: expect.objectContaining({
            runtimeId: "codex",
            codecVersion: "v1",
            payload: expect.objectContaining({
              native: expect.objectContaining({ threadId: "thread-roundtrip-1" }),
            }),
          }),
        }),
      ]),
    );

    const restored = new AgentHub();
    await restored.loadPersistedState(storagePath);
    const restoredChat = restored.snapshot().chats.find((item) => item.id === chat.id);
    expect(restoredChat?.runtimeState).toMatchObject({
      executionStyle: "interactive",
      attachmentState: "detached",
      attachmentGeneration: 0,
      lastMeaningfulActivityAt: 1710000000500,
      capabilities: {
        supportsInProcessConversationResume: true,
        supportsResumeAfterDetach: true,
        supportsResumeAfterAppRestart: true,
        supportsTurnResume: false,
        supportsInterrupt: true,
        supportsContinue: true,
        supportsApprovalRequests: true,
        supportsUserInputRequests: true,
      },
    });
    expect(restoredChat?.runtimeState?.activeTurnId).toBeUndefined();
    expect(restoredChat?.runtimeConversation).toEqual(
      runtimeConversation("codex", {
        native: { threadId: "thread-roundtrip-1", sessionTreeRootId: "tree-root-1" },
        appContext: {
          cwd: dir,
          modelId: DEFAULT_MODEL_ID,
          approvalPolicy: "never",
          sandboxPolicy: { mode: "workspace-write" },
        },
        extensions: { source: "test" },
      }),
    );
  });

  test("discards persisted state when runtimeConversation payload is rejected by the runtime codec", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-runtime-session-resume-fallback-"));
    const storagePath = path.join(dir, "app-chats.json");
    await writeFile(
      storagePath,
      JSON.stringify({
        version: 5,
        activeChatId: "chat-1",
        workDir: dir,
        sessions: [
          {
            id: "chat-1",
            title: "Broken resume state",
            configuredAgentId: TEST_CODEX_AGENT_ID,
            modelId: DEFAULT_MODEL_ID,
            runtimeState: {
              executionStyle: "interactive",
              attachmentState: "idle",
              attachmentGeneration: 3,
              capabilities: {
                supportsInProcessConversationResume: true,
                supportsResumeAfterDetach: true,
                supportsResumeAfterAppRestart: true,
                supportsTurnResume: false,
                supportsInterrupt: true,
                supportsContinue: true,
                supportsApprovalRequests: false,
                supportsUserInputRequests: false,
              },
            },
            runtimeConversation: {
              runtimeId: "codex",
              codecVersion: "v1",
              payload: {},
            },
            createdAt: 1710000000000,
            updatedAt: 1710000000000,
          },
        ],
        messages: [],
        events: [],
        tasks: [],
        taskMessages: [],
        taskEvents: [],
      }),
      "utf8",
    );

    const hub = new AgentHub();
    await hub.loadPersistedState(storagePath);

    const snapshot = hub.snapshot();
    expect(snapshot.chats.some((item) => item.id === "chat-1")).toBe(false);
    expect(snapshot.chats).toHaveLength(1);
  });

  test("downgrades pending approval and input requests to expired on restore", () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    const restored = (hub as any).restoreChatState({
      id: "chat-1",
      title: "Chat",
      configuredAgentId: TEST_CODEX_AGENT_ID,
      modelId: "default",
      runtimeState: {
        executionStyle: "interactive",
        attachmentState: "running",
        attachmentGeneration: 9,
        capabilities: {
          supportsInProcessConversationResume: true,
          supportsResumeAfterDetach: false,
          supportsResumeAfterAppRestart: false,
          supportsTurnResume: false,
          supportsInterrupt: true,
          supportsContinue: true,
          supportsApprovalRequests: true,
          supportsUserInputRequests: true,
        },
      },
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "",
          timestamp: 0,
          events: [
            { id: "evt-1", type: "approval_request", content: "Allow Bash?", requestId: "approval-1", requestState: "live", timestamp: 1 },
            { id: "evt-2", type: "user_input_request", content: "Provide token", requestId: "input-1", requestState: "live", timestamp: 2 },
          ],
        },
      ],
      createdAt: 0,
      updatedAt: 0,
    });

    expect(restored?.messages[0]?.events).toEqual([
      expect.objectContaining({ type: "approval_request", requestState: "expired" }),
      expect.objectContaining({ type: "user_input_request", requestState: "expired" }),
    ]);
  });

  test("persists execution channel config in app state and restores it ahead of legacy channel file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-channels-"));
    const storagePath = path.join(dir, "app-chats.json");
    const channelPath = path.join(dir, "model-channels.json");
    const persistedChannels: AgentChannel[] = [
      {
        id: "codex-deepseek",
        agentId: "codex",
        label: "Codex DeepSeek",
        providerName: "DeepSeek",
        modelProvider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        wireApi: "responses",
        apiFormat: "openai_responses",
        isFullUrl: false,
        httpHeaders: { Authorization: "Bearer persisted-key" },
        environment: { DEEPSEEK_REGION: "cn" },
        requestOverrides: { headers: { "x-provider": "deepseek" }, body: { service_tier: "priority" } },
        plugins: [{ id: "github@openai-curated", enabled: true }],
        models: [
          { id: DEFAULT_MODEL_ID, label: "Default" },
          { id: "deepseek-chat", label: "DeepSeek Chat" },
        ],
      },
    ];

    const hub = new AgentHub();
    await hub.loadModelChannels(channelPath);
    await hub.loadPersistedState(storagePath);
    await hub.saveModelChannels(persistedChannels);
    await hub.flushPersistence();

    const persisted = JSON.parse(await readFile(storagePath, "utf8")) as { channels?: AgentChannel[] };
    expect(persisted.channels).toEqual([
      expect.objectContaining({
        id: "codex-deepseek",
        providerName: "DeepSeek",
        httpHeaders: { Authorization: "Bearer persisted-key" },
        apiFormat: "openai_responses",
        isFullUrl: false,
        environment: { DEEPSEEK_REGION: "cn" },
        requestOverrides: { headers: { "x-provider": "deepseek" }, body: { service_tier: "priority" } },
        plugins: [{ id: "github@openai-curated", enabled: true }],
      }),
    ]);

    const legacyHub = new AgentHub();
    await legacyHub.loadModelChannels(channelPath);
    await legacyHub.saveModelChannels([
      {
        id: "codex-openai",
        agentId: "codex",
        label: "Codex OpenAI",
        providerName: "OpenAI",
        modelProvider: "openai",
        models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
      },
    ]);

    const restored = new AgentHub();
    await restored.loadModelChannels(channelPath);
    await restored.loadPersistedState(storagePath);
    const snapshot = restored.snapshot();

    expect(snapshot.channels.map((channel) => channel.id)).toEqual(["codex-deepseek"]);
    expect(snapshot.channels[0]).toMatchObject({
      providerName: "DeepSeek",
      httpHeaders: { Authorization: "Bearer persisted-key" },
      plugins: [{ id: "github@openai-curated", enabled: true }],
    });
  });

  test("refreshes one model catalog without removing cached models", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-model-refresh-"));
    const hub = new AgentHub({}, undefined, undefined, async () => ({
      source: "codex_cli",
      models: [{
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        reasoningEfforts: ["low", "xhigh", "ultra"],
        defaultReasoningEffort: "low",
      }],
    }));
    await hub.loadModelChannels(path.join(dir, "model-channels.json"));
    await hub.saveModelChannels([{
      id: "codex-official",
      agentId: "codex",
      label: "Codex Official",
      modelProvider: "openai",
      models: [
        { id: "default", label: "Default" },
        { id: "private-model", label: "Private" },
      ],
    }]);

    const result = await hub.refreshModelCatalog("codex-official");

    expect(result).toMatchObject({ channelId: "codex-official", source: "codex_cli", discoveredCount: 1 });
    expect(result.snapshot.channels[0]?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "private-model" }),
      expect.objectContaining({ id: "gpt-5.6-sol", reasoningEfforts: ["low", "xhigh", "ultra"] }),
    ]));
  });

  test("reports the selected Provider as the model catalog source", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-provider-model-refresh-"));
    const hub = new AgentHub({}, undefined, undefined, async () => ({
      source: "openai_models",
      models: [{ id: "deepseek-chat", label: "DeepSeek Chat" }],
    }));
    await hub.loadModelChannels(path.join(dir, "model-channels.json"));
    await hub.saveModelChannels([{
      id: "claude-deepseek",
      agentId: "claude",
      label: "Claude Code + DeepSeek",
      presetId: "claude-code-deepseek",
      providerName: "DeepSeek",
      modelProvider: "deepseek-anthropic",
      models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
    }]);

    const result = await hub.refreshModelCatalog("claude-deepseek");

    expect(result).toMatchObject({
      channelId: "claude-deepseek",
      source: "openai_models",
      providerLabel: "DeepSeek",
      discoveredCount: 1,
    });
  });

  test("stores execution channel config in app state without rewriting the legacy channel file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-channel-db-"));
    const dbPath = path.join(dir, "app.db");
    const channelPath = path.join(dir, "model-channels.json");
    const storedChannels: AgentChannel[] = [
      {
        id: "deepseek-api-agent-channel",
        agentId: "api",
        label: "DeepSeek API Agent",
        providerName: "DeepSeek",
        modelProvider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        httpHeaders: { Authorization: "Bearer db-key" },
        models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
      },
    ];

    const hub = new AgentHub({ codex: "missing-codex-for-test" });
    await hub.loadModelChannels(channelPath);
    await hub.loadPersistedState(dbPath);
    await hub.saveModelChannels(storedChannels);
    await hub.flushPersistence();

    await expect(readFile(channelPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const restored = new AgentHub({ codex: "missing-codex-for-test" });
    await restored.loadModelChannels(channelPath);
    await restored.loadPersistedState(dbPath);

    expect(restored.snapshot().channels).toEqual([
      expect.objectContaining({
        id: "deepseek-api-agent-channel",
        providerName: "DeepSeek",
        httpHeaders: { Authorization: "Bearer db-key" },
      }),
    ]);
  });

  test("persists and restores a stored preset id through SQLite-backed app state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-preset-id-db-"));
    const dbPath = path.join(dir, "app.db");
    const channelPath = path.join(dir, "model-channels.json");
    const storedChannels: AgentChannel[] = [
      {
        id: "codex-default-runtime",
        agentId: "codex",
        label: "Codex Default",
        presetId: "codex-default",
        modelProvider: "bridge",
        providerName: "Bridge",
        baseUrl: "https://bridge.example/v1",
        wireApi: "responses",
        models: [
          { id: DEFAULT_MODEL_ID, label: "Default" },
          { id: "gpt-5.5", label: "gpt-5.5" },
        ],
      },
    ];

    const hub = new AgentHub({ codex: "missing-codex-for-test" });
    await hub.loadModelChannels(channelPath);
    await hub.loadPersistedState(dbPath);
    await hub.saveModelChannels(storedChannels);
    await hub.flushPersistence();

    const restored = new AgentHub({ codex: "missing-codex-for-test" });
    await restored.loadModelChannels(channelPath);
    await restored.loadPersistedState(dbPath);

    expect(restored.snapshot().channels).toEqual([
      expect.objectContaining({
        id: "codex-default-runtime",
        presetId: "codex-default",
        modelProvider: "bridge",
        providerName: "Bridge",
      }),
    ]);
  });

  test("does not salvage legacy JSON history into SQLite storage", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-sqlite-"));
    const legacyPath = path.join(dir, "app-chats.json");
    const dbPath = path.join(dir, "app.db");
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: 5,
        activeChatId: "chat-legacy",
        workDir: "/tmp/legacy-project",
        sessions: [
          {
            id: "chat-legacy",
            title: "Legacy JSON",
            configuredAgentId: TEST_CODEX_AGENT_ID,
            modelId: DEFAULT_MODEL_ID,
            running: false,
            messages: [],
            createdAt: 1710000000000,
            updatedAt: 1710000000000,
          },
        ],
        messages: [],
        events: [],
        tasks: [],
        taskMessages: [],
        taskEvents: [],
      }),
      "utf8",
    );

    const migrated = new AgentHub();
    await migrated.loadPersistedState(dbPath);
    expect(migrated.snapshot().chats.some((item) => item.id === "chat-legacy")).toBe(false);
    migrated.setWorkDir("/tmp/sqlite-project");
    await migrated.flushPersistence();
    expect((await readFile(dbPath)).byteLength).toBeGreaterThan(0);

    const restored = new AgentHub();
    await restored.loadPersistedState(dbPath);
    const snapshot = restored.snapshot();
    expect(snapshot.workDir).toBe("/tmp/sqlite-project");
    expect(snapshot.chats.some((item) => item.id === "chat-legacy")).toBe(false);
  });

});

