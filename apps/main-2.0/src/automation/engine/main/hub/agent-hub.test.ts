import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { AgentHub as AgentHubImplementation } from "./agent-hub";
import { DEFAULT_MODEL_ID } from "../../shared/models";
import { RUNTIME_DEFINITIONS } from "../../shared/runtime-catalog";
import type { AgentChannel, AgentId, ConfiguredAgent, RuntimeConversation } from "../../shared/types";
import { createRuntimeDriverRegistry, RuntimeDriverRegistry } from "./runtime/executor/agent-executor";
import type { RuntimeAgentExecutorFactoryOptions } from "./runtime/executor/agent-executor";
import { createClaudeDriver } from "./runtime/executor/claude/create-claude-driver";
import { writeNodeCliLauncher } from "../platform/test-cli-fixtures";
import type { PersistedAppStateV5 } from "./persisted/agent-hub-persistence";
import type { AgentHubPersistedStore } from "./persisted/persisted-store";

const TEST_CODEX_AGENT_ID = "runtime-agent:codex-openai";

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
  if (message.method === "plugin/list") {
    write({ jsonrpc: "2.0", id: message.id, result: { marketplaces, marketplaceLoadErrors: [], featuredPluginIds: [] } });
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

describe("AgentHub runtime & configured agents", () => {
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

    hub.updateConfiguredAgents(
      hub.snapshot().configuredAgents.filter((agent) => agent.id !== "runtime-agent:codex-glm"),
      { detectDeletedManagedAgents: true },
    );
    expect(hub.snapshot().configuredAgents.find((agent) => agent.id === "runtime-agent:codex-glm")).toBeUndefined();

    (hub as any).installRestoredConfiguredAgents([]);
    expect(hub.snapshot().configuredAgents.find((agent) => agent.id === "runtime-agent:codex-glm")).toBeUndefined();
    expect(hub.snapshot().configuredAgents.find((agent) => agent.id === TEST_CODEX_AGENT_ID)).toBeDefined();

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
      await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
    }
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
    expect(hub.snapshot().chats).toHaveLength(before.chats.length);

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

  test("handles fresh and resumed one-shot runs through Codex and Claude SDK", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-oneshot-resume-"));
    const fake = await writeSequentialCodexFake(dir);
    const codexHub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (codexHub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });

    const freshCodex = await (codexHub as any).askConfiguredAgent({
      requestId: "oneshot-fresh-test",
      prompt: "Start fresh.",
      configuredAgentId: TEST_CODEX_AGENT_ID,
      workDir: dir,
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-old" } }),
    });
    expect(freshCodex.executionReference).toEqual({ sessionId: "thread-1", turnId: "turn-1" });

    const resumedCodex = await (codexHub as any).askConfiguredAgent({
      requestId: "oneshot-resume-test",
      prompt: "Continue.",
      configuredAgentId: TEST_CODEX_AGENT_ID,
      workDir: dir,
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "resume-preferred",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-7" } }),
    });
    expect(resumedCodex.executionReference).toEqual({ sessionId: "thread-7", turnId: "turn-2" });

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "thread/resume" && call.params.threadId === "thread-7")).toHaveLength(1);

    const runOneShot = vi.fn(async (input: any) => {
      input.onEvent({
        type: "runtime_conversation",
        runtimeConversation: runtimeConversation("claude", { native: { sessionId: input.resumeSessionId ?? "claude-session-7" } }),
      });
      input.onEvent({ type: "completed", content: input.resumeSessionId ? "oneshot-resumed" : "oneshot-sdk" });
    });
    const claudeHub = createHubWithClaudeOneShot(runOneShot);
    addConfiguredAgents(claudeHub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);
    (claudeHub as any).runtimes.set("claude", { id: "claude", label: "Claude", command: "claude", version: "test", available: true });

    await (claudeHub as any).askConfiguredAgent({
      requestId: "claude-fresh",
      prompt: "Fresh",
      configuredAgentId: "claude-agent",
      workDir: dir,
      runtimeId: "claude",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-old" } }),
    });
    expect(runOneShot.mock.calls[0]?.[0]?.resumeSessionId).toBeUndefined();

    await (claudeHub as any).askConfiguredAgent({
      requestId: "claude-resume",
      prompt: "Resume",
      configuredAgentId: "claude-agent",
      workDir: dir,
      runtimeId: "claude",
      executionMode: "oneshot",
      continuationPolicy: "resume-preferred",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
      runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-9" } }),
    });
    expect(runOneShot.mock.calls[1]?.[0]?.resumeSessionId).toBe("claude-session-9");
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
    try {
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
    } finally {
      vi.unstubAllGlobals();
    }
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

  test("skips shutdown persistence errors while still reporting real persistence failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const shutdownStore: AgentHubPersistedStore = {
        label: "shutdown store",
        load: async () => undefined,
        save: vi.fn(async () => {
          throw Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
        }),
        close: () => undefined,
        isShutdownError: () => true,
      };
      const shutdownHub = new AgentHub();
      await shutdownHub.loadPersistedState(shutdownStore);
      await expect(shutdownHub.flushPersistence()).resolves.toBeUndefined();
      await expect(shutdownHub.shutdown()).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();

      const failingStore: AgentHubPersistedStore = {
        label: "test store",
        load: async () => undefined,
        save: vi.fn(async () => {
          throw new Error("disk full");
        }),
        close: () => undefined,
        isShutdownError: () => false,
      };
      const failingHub = new AgentHub();
      await failingHub.loadPersistedState(failingStore);
      await expect(failingHub.flushPersistence()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "Failed to persist app state to test store:",
        expect.objectContaining({ message: "disk full" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("persists execution channel config in app state ahead of legacy channel file and refreshes models", async () => {
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
          { id: "private-model", label: "Private" },
        ],
      },
    ];

    const hub = new AgentHub({}, undefined, undefined, async () => ({
      source: "codex_cli",
      models: [{
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        reasoningEfforts: ["low", "xhigh", "ultra"],
        defaultReasoningEffort: "low",
      }],
    }));
    await hub.loadModelChannels(channelPath);
    await hub.loadPersistedState(storagePath);
    await hub.saveModelChannels(persistedChannels);
    const refreshed = await hub.refreshModelCatalog("codex-deepseek");
    expect(refreshed).toMatchObject({
      channelId: "codex-deepseek",
      source: "codex_cli",
      providerLabel: "Codex CLI",
      discoveredCount: 1,
    });
    expect(refreshed.snapshot.channels[0]?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "private-model" }),
      expect.objectContaining({ id: "gpt-5.6-sol", reasoningEfforts: ["low", "xhigh", "ultra"] }),
    ]));
    await hub.flushPersistence();

    const restored = new AgentHub();
    await restored.loadModelChannels(channelPath);
    await restored.loadPersistedState(storagePath);
    expect(restored.snapshot().channels).toEqual([
      expect.objectContaining({
        id: "codex-deepseek",
        providerName: "DeepSeek",
        httpHeaders: { Authorization: "Bearer persisted-key" },
        plugins: [{ id: "github@openai-curated", enabled: true }],
      }),
    ]);
  });
});
