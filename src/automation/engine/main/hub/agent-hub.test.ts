import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { AgentHub, createWorkflowAgentTimeout } from "./agent-hub";
import { DEFAULT_MODEL_ID } from "../../shared/models";
import { projectNodeStates } from "../../shared/workflow-v2/runtime-utils";
import { createWorkflowV2InlineScriptSpec } from "../../shared/workflow-v2/definition";
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

function createV2Workflow(hub: AgentHub, input: any): any {
  const agentNodes = input.graph?.nodes?.filter((node: any) => node.kind === "agent") ?? [];
  const agentNodeIds = new Set(agentNodes.map((node: any) => node.id));
  const draft = hub.createWorkflowDraft({ configuredAgentId: input.configuredAgentId });
  const workflowId = draft.workflowDraft!.workflowId;
  const result = hub.materializeWorkflowDraft(workflowId, {
    ...input,
    definition: input.definition ?? {
      workflowId: "test-placeholder",
      graphVersion: 1,
      objective: input.objective,
      nodes: agentNodes.map((node: any) => ({
        id: node.id,
        kind: "implementation",
        title: node.title,
        execModel: "llm",
        executionMode: "one-shot",
        prompt: node.prompt,
        outputFields: [{ key: "result", required: true }],
      })),
      edges: (input.graph?.edges ?? [])
        .filter((edge: any) => agentNodeIds.has(edge.fromNodeId) && agentNodeIds.has(edge.toNodeId))
        .map((edge: any) => ({ fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId })),
    },
  });
  if (result.ok) {
    const route = hub.snapshot().workflowDraft!;
    const scriptRisks = Object.fromEntries(route.workflowV2Plan?.definition.nodes.filter((node) => node.execModel === "script").map((node) => [node.id, { level: node.script.managerRisk.level, rationale: "Matches the Manager classification in this test fixture." }]) ?? []);
    hub.patchWorkflowDraft({ workflowId, generationReview: { status: "approved", reviewerConfiguredAgentId: route.reviewerConfiguredAgentId, reviewerModelId: route.reviewerModelId, reviewedRevision: route.revision, result: { verdict: "approve", reviewedRevision: route.revision, summary: "Approved by test reviewer", findings: [], scriptRisks, suggestions: [] }, updatedAt: 1 } });
    hub.confirmWorkflow({ workflowId, expectedRevision: route.revision });
  }
  return result;
}

function interactiveChatCapabilities(runtimeId: AgentId) {
  return {
    runtimeId,
    chatStyle: "interactive" as const,
    taskStyle: "oneshot" as const,
    workflowStyle: "oneshot" as const,
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
    taskStyle: "oneshot" as const,
    workflowStyle: "oneshot" as const,
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
  surface: "chat" | "task" | "workflow" | "channel-test" | "cleanup",
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
  workflowMcpDiscoveryPath?: () => string | undefined,
): AgentHub {
  let hub: AgentHub;
  const resolvedExecutables = {
    codex: executables.codex ?? "missing-codex-for-test",
    claude: executables.claude ?? "missing-claude-for-test",
    api: executables.api ?? "api",
    hermes: executables.hermes ?? "missing-hermes-for-test",
    opencode: executables.opencode ?? "missing-opencode-for-test",
    openclaw: executables.openclaw ?? "missing-openclaw-for-test",
  };
  const options: RuntimeAgentExecutorFactoryOptions = {
    executables: resolvedExecutables,
    channelById: (channelId) => (hub as any).channelById(channelId),
    mcpServersForAgent: (configuredAgentId) => (hub as any).boundMcpServersForAgent(configuredAgentId),
    ...(workflowMcpDiscoveryPath ? { workflowMcpDiscoveryPath } : {}),
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
      executables: { codex: "codex", claude: "claude", api: "api", hermes: "hermes", opencode: "opencode", openclaw: "openclaw" },
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
    executables: { codex: "codex", claude: "claude", api: "api", hermes: "hermes", opencode: "opencode", openclaw: "openclaw" },
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

test("workflow and generic Agent execution use the correct instruction scope", async () => {
  const workflow = vi.fn(async () => ({
    content: "hermes workflow",
  }));
  const hub = new AgentHub(
    { codex: "missing-codex-for-test", claude: "missing-claude-for-test", hermes: "missing-hermes-for-test" } as any,
    undefined,
    new RuntimeDriverRegistry([
      {
        runtimeId: "hermes",
        surfaceSupport: [support("workflow", ["oneshot"], ["fresh"])],
        getCapabilities: () => oneshotChatCapabilities("hermes"),
        createOneShotExecutor: () => ({ start: async () => undefined, stop: async () => undefined }),
        askWorkflow: workflow,
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

  const response = await hub.askWorkflowAgent({
    prompt: "Plan the repo",
    configuredAgentId: "hermes-agent",
    runtimeId: "hermes",
    executionMode: "oneshot",
    continuationPolicy: "fresh",
    runtimeConfig: { model: DEFAULT_MODEL_ID },
  });

  expect(response).toEqual({
    content: "hermes workflow",
  });
  expect(workflow).toHaveBeenNthCalledWith(1, expect.objectContaining({
    configuredAgentId: "hermes-agent",
    developerInstructions: "Follow the configured Agent policy.",
    instructionScope: "workflow",
  }));

  await hub.askConfiguredAgent({
    prompt: "Evaluate the answer",
    configuredAgentId: "hermes-agent",
    runtimeId: "hermes",
    executionMode: "oneshot",
    continuationPolicy: "fresh",
    runtimeConfig: { model: DEFAULT_MODEL_ID },
  });
  expect(workflow).toHaveBeenNthCalledWith(2, expect.objectContaining({
    developerInstructions: "Follow the configured Agent policy.",
    instructionScope: "agent",
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
fs.appendFileSync(callsPath, JSON.stringify({ method: "process/argv", params: { args: process.argv.slice(2), workflowId: process.env.AGENT_RECALL_WORKFLOW_ID, managedToken: process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN } }) + "\\n");

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
          tools: { workflow_create: {}, workflow_node_complete: {} },
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

  test("creates default agents once without binding their later edits to runtime configs", () => {
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
        expect.objectContaining({ id: "default-agent", name: "Codex Official", channelId: "codex-openai", managed: true }),
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

  test("refreshes workflow agent timeout after activity", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const timeout = createWorkflowAgentTimeout({ timeoutMs: 1000, onTimeout });

      vi.advanceTimersByTime(900);
      timeout.refresh();
      vi.advanceTimersByTime(900);

      expect(onTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      timeout.clear();
    } finally {
      vi.useRealTimers();
    }
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
      runKind: "chat",
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
            configuredAgentId: "default-agent",
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
        teams: [],
        teamRuns: [],
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
            configuredAgentId: "default-agent",
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
        teams: [],
        teamRuns: [],
      }),
      "utf8",
    );

    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [support("task", ["oneshot"], ["fresh"])],
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
      runKind: "chat",
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
      runKind: "chat",
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
        surfaceSupport: [support("task", ["oneshot"], ["fresh"])],
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
      runKind: "chat",
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
      runKind: "chat",
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

  test("starts with one codex chat selected", () => {
    const hub = new AgentHub();
    const snapshot = hub.snapshot();
    const activeChat = snapshot.chats.find((chat) => chat.id === snapshot.activeChatId);

    expect(snapshot.chats).toHaveLength(1);
    expect(activeChat?.configuredAgentId).toBe("default-agent");
    expect(snapshot.configuredAgents.find((agent) => agent.id === activeChat?.configuredAgentId)).toMatchObject({
      runtimeAgentId: "codex",
      channelId: "codex-openai",
    });
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
    const secondChat = hub.createChat("default-agent");
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

    hub.setChatAgent(secondChat.id, "default-agent");

    const snapshot = hub.snapshot();
    const firstChat = snapshot.chats.find((chat) => chat.id === firstChatId);
    const activeChat = snapshot.chats.find((chat) => chat.id === snapshot.activeChatId);

    expect(firstChat?.configuredAgentId).toBe("default-agent");
    expect(activeChat?.id).toBe(secondChat.id);
    expect(activeChat?.configuredAgentId).toBe("default-agent");
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
    expect(activeChat?.configuredAgentId).toBe("default-agent");

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
    expect(activeChat?.configuredAgentId).toBe("default-agent");
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

    const chat = hub.createChat();
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
    const chat = hub.createChat();
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
      configuredAgentId: "default-agent",
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
    const chat = (hub as any).createChatState("default-agent");

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

  test("asks a workflow agent through Codex without creating a visible chat or task", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-workflow-agent-"));
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
    const response = await (hub as any).askWorkflowAgent({
      requestId: "workflow-test",
      prompt: "You are a Loop Engineering Agent. Ask one question.",
      configuredAgentId: "default-agent",
      workDir: dir,
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
    }, (event: any) => events.push(event));

    expect(response).toEqual({
      content: "artifact-1",
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-1" } }),
    });
    expect(events).toEqual([
      { requestId: "workflow-test", type: "delta", content: "artifact-1" },
      {
        requestId: "workflow-test",
        type: "completed",
        content: "artifact-1",
        runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-1" } }),
      },
    ]);
    const after = hub.snapshot();
    expect(after.chats).toHaveLength(before.chats.length);
    expect(after.tasks).toHaveLength(0);

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    expect(calls.some((call) => call.method === "turn/start" && call.params.input[0].text.includes("Loop Engineering Agent"))).toBe(true);
    expect(calls.some((call) => call.method === "thread/start" && call.params.developerInstructions.includes("Final User Report"))).toBe(true);
  });

  test("injects the workflow MCP server into Codex planning runs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-workflow-mcp-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });

    hub.setWorkflowMcpDiscoveryPath(path.join(dir, "mcp-bridge.json"));
    hub.setWorkflowMcpManagedToken("managed-token");
    await (hub as any).askWorkflowAgent({
      requestId: "workflow-mcp-config-test",
      planningWorkflowId: "wf-codex-planning",
      prompt: "Use workflow tools when ready.",
      configuredAgentId: "default-agent",
      workDir: dir,
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
    });

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    const argv = calls.find((call) => call.method === "process/argv")?.params.args as string[];
    expect(argv.join("\n")).toContain("mcp_servers.agent_recall.command");
    expect(argv.join("\n")).toContain("AGENT_RECALL_WORKFLOW_MCP_BRIDGE");
    const processConfig = calls.find((call) => call.method === "process/argv")?.params;
    expect(processConfig.workflowId).toBe("wf-codex-planning");
    expect(processConfig.managedToken).toBe("managed-token");
    expect(argv.join("\n")).not.toContain("managed-token");
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
    hub.updateConfiguredAgents(hub.snapshot().configuredAgents.map((agent) => agent.id === "default-agent"
      ? { ...agent, mcpBindings: [{ serverId: "bound", toolAllowlist: [] }] }
      : agent));

    await hub.askWorkflowAgent({
      requestId: "bound-mcp-codex",
      prompt: "Use the bound server.",
      configuredAgentId: "default-agent",
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

  test("asks a Claude workflow agent through the official SDK one-shot path without resuming when continuationPolicy is fresh", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-workflow-sdk-"));
    const runOneShot = vi.fn(async (input: any) => {
      input.onEvent({
        type: "runtime_conversation",
        runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-7" } }),
      });
      input.onEvent({ type: "delta", content: "workflow-sdk" });
      input.onEvent({ type: "completed", content: "workflow-sdk" });
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
    const response = await (hub as any).askWorkflowAgent(
      {
        requestId: "claude-workflow-test",
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
      content: "workflow-sdk",
      runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-7" } }),
    });
    expect(events).toEqual([
      { requestId: "claude-workflow-test", type: "delta", content: "workflow-sdk" },
      {
        requestId: "claude-workflow-test",
        type: "completed",
        content: "workflow-sdk",
        runtimeConversation: runtimeConversation("claude", { native: { sessionId: "claude-session-7" } }),
      },
    ]);
    const oneShotInput = runOneShot.mock.calls[0]?.[0];
    expect(oneShotInput).toMatchObject({
      prompt: "Plan the repo",
      cwd: dir,
      developerInstructions: expect.stringContaining("Workflow V2 Manager"),
    });
    expect(oneShotInput?.resumeSessionId).toBeUndefined();
  });

  test("injects a session-scoped workflow MCP server into Claude planning runs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-planning-"));
    const runOneShot = vi.fn(async (input: any) => {
      input.onEvent({ type: "delta", content: "workflow-sdk" });
      input.onEvent({ type: "completed", content: "workflow-sdk" });
    });
    const discoveryPath = path.join(dir, "mcp-bridge.json");
    const hub = createHubWithClaudeOneShot(runOneShot, {}, () => discoveryPath);
    addConfiguredAgents(hub, [configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" })]);
    (hub as any).runtimes.set("claude", {
      id: "claude",
      label: "Claude",
      command: "claude",
      version: "test",
      available: true,
    });

    await (hub as any).askWorkflowAgent({
      requestId: "claude-planning-no-injection-test",
      planningWorkflowId: "wf-claude-planning",
      prompt: "Plan the repo",
      configuredAgentId: "claude-agent",
      workDir: dir,
      runtimeId: "claude",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
    });

    const oneShotInput = runOneShot.mock.calls[0]?.[0];
    expect(oneShotInput?.mcpServers?.agent_recall).toMatchObject({
      type: "stdio",
      env: expect.objectContaining({
        AGENT_RECALL_WORKFLOW_MCP_BRIDGE: discoveryPath,
        AGENT_RECALL_WORKFLOW_ID: "wf-claude-planning",
      }),
    });
  });

  test("combines workflow and Agent-bound MCP servers for Claude", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-bound-mcp-claude-"));
    const runOneShot = vi.fn(async (input: any) => {
      input.onEvent({ type: "completed", content: "done" });
    });
    const hub = createHubWithClaudeOneShot(runOneShot);
    addConfiguredAgents(hub, [{
      ...configuredAgent("claude-agent", { runtimeAgentId: "claude", name: "Claude Agent" }),
      mcpBindings: [{ serverId: "remote", toolAllowlist: [] }],
    }]);
    hub.setMcpServers([
      { id: "remote", name: "Remote", transport: "http", args: [], url: "https://example.test/mcp", env: {}, enabled: true, tools: [], status: "connected", createdAt: 1, updatedAt: 1 },
    ]);
    (hub as any).runtimes.set("claude", { id: "claude", label: "Claude", command: "claude", version: "test", available: true });

    await hub.askWorkflowAgent({
      requestId: "bound-mcp-claude",
      prompt: "Use the bound server.",
      configuredAgentId: "claude-agent",
      workDir: dir,
      runtimeId: "claude",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: DEFAULT_MODEL_ID },
    });

    expect(Object.values(runOneShot.mock.calls[0]?.[0].mcpServers ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "http", url: "https://example.test/mcp" }),
    ]));
  });

  test("resumes a Claude workflow agent through the official SDK one-shot path when continuationPolicy is resume-preferred", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-workflow-sdk-resume-"));
    const runOneShot = vi.fn(async (input: any) => {
      input.onEvent({ type: "delta", content: "workflow-resumed" });
      input.onEvent({ type: "completed", content: "workflow-resumed" });
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
    const response = await (hub as any).askWorkflowAgent({
      requestId: "claude-workflow-resume-test",
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
      content: "workflow-resumed",
      runtimeConversation: priorConversation,
    });
    const oneShotInput = runOneShot.mock.calls[0]?.[0];
    expect(oneShotInput).toMatchObject({
      prompt: "Continue the repo plan",
      cwd: dir,
      developerInstructions: expect.stringContaining("Workflow V2 Manager"),
      resumeSessionId: "claude-session-9",
    });
  });

  test("starts a fresh workflow run when the request explicitly chooses fresh despite carrying runtimeConversation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-workflow-agent-fresh-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });

    const response = await (hub as any).askWorkflowAgent({
      requestId: "workflow-fresh-test",
      prompt: "Start fresh from the updated spec.",
      configuredAgentId: "default-agent",
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
    });

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(0);
  });

  test("resumes a workflow run only when the request explicitly chooses resume-preferred", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-workflow-agent-resume-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });

    const response = await (hub as any).askWorkflowAgent({
      requestId: "workflow-resume-test",
      prompt: "Continue from the prior workflow turn.",
      configuredAgentId: "default-agent",
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
    });

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "thread/resume" && call.params.threadId === "thread-7")).toHaveLength(1);
  });

  test("keeps workflow draft replies in one interactive session without creating chats or tasks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-workflow-draft-reply-"));
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
    const created = hub.createWorkflowDraft({ configuredAgentId: "default-agent" });
    const workflowId = created.workflowDraft?.workflowId;
    expect(workflowId).toBeTruthy();

    const first = await hub.sendWorkflowDraftReply({
      workflowId: workflowId!,
      reply: "Ask one question about the repo layout.",
    });
    expect(first.workflowDraft).toMatchObject({
      workflowId,
      objective: "Ask one question about the repo layout.",
      runtimeConversation: {
        runtimeId: "codex",
        codecVersion: "v1",
        payload: { native: { threadId: "thread-1" } },
      },
      messages: [
        { role: "user", content: "Ask one question about the repo layout." },
        { role: "assistant", content: "artifact-1" },
      ],
    });

    const second = await hub.sendWorkflowDraftReply({
      workflowId: workflowId!,
      reply: "Use that answer and propose the next step.",
    });
    expect(second.workflowDraft).toMatchObject({
      workflowId,
      objective: "Ask one question about the repo layout.",
      runtimeConversation: {
        runtimeId: "codex",
        codecVersion: "v1",
        payload: { native: { threadId: "thread-1" } },
      },
      messages: [
        { role: "user", content: "Ask one question about the repo layout." },
        { role: "assistant", content: "artifact-1" },
        { role: "user", content: "Use that answer and propose the next step." },
        { role: "assistant", content: "artifact-2" },
      ],
    });
    expect(second.chats).toHaveLength(before.chats.length);
    expect(second.tasks).toHaveLength(before.tasks.length);

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
    expect(calls.filter((call) => call.method === "process/argv")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
    expect((calls.find((call) => call.method === "process/argv")?.params.args as string[]).join("\n"))
      .not.toContain("mcp_servers.agent_recall");
  });

  test("rejects one-shot-only runtimes in the Workflow planning dialog", async () => {
    const hub = new AgentHub({
      codex: "missing-codex-for-test",
      claude: "missing-claude-for-test",
      api: "api",
    });
    addConfiguredAgents(hub, [configuredAgent("api-agent", { runtimeAgentId: "api" })]);
    (hub as any).runtimes.set("api", {
      id: "api",
      label: "API",
      command: "api",
      version: "test",
      available: true,
    });
    const workflowId = hub.createWorkflowDraft({ configuredAgentId: "api-agent" }).workflowDraft!.workflowId;

    const snapshot = await hub.sendWorkflowDraftReply({ workflowId, reply: "Plan this task." });

    expect(snapshot.workflowDraft?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Plan this task." }),
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("does not support interactive workflow planning"),
      }),
    ]);
    expect(snapshot.workflowDraft?.runtimeConversation).toBeUndefined();
  });

  test("uses the workflow-selected model for workflow agent API requests", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-workflow-model-"));
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
      new Response(JSON.stringify({ choices: [{ message: { content: "workflow-ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await (hub as any).askWorkflowAgent({
      prompt: "Use workflow selected model.",
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
            configuredAgentId: "default-agent",
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
        teams: [],
        teamRuns: [],
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

  test("persists task runtimeConversation in the new schema", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-task-runtime-conversation-"));
    const storagePath = path.join(dir, "app-chats.json");
    const hub = new AgentHub();

    await hub.loadPersistedState(storagePath);
    const task = (hub as any).createTaskState({
      prompt: "Inspect the repo",
      configuredAgentId: "default-agent",
      workDir: dir,
    });
    task.runtimeConversation = runtimeConversation("codex", { native: { threadId: "task-thread-1" } });
    (hub as any).tasks.set(task.id, task);
    hub.selectTask(task.id);

    await hub.flushPersistence();

    const persisted = JSON.parse(await readFile(storagePath, "utf8")) as any;
    expect(persisted.version).toBe(5);
    expect(persisted.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: task.id,
          runtimeConversation: runtimeConversation("codex", { native: { threadId: "task-thread-1" } }),
        }),
      ]),
    );
    expect(persisted.tasks[0]).not.toHaveProperty("sessionId");

    const restored = new AgentHub();
    await restored.loadPersistedState(storagePath);
    expect(restored.snapshot().tasks.find((item) => item.id === task.id)?.runtimeConversation).toEqual(
      runtimeConversation("codex", { native: { threadId: "task-thread-1" } }),
    );
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
            configuredAgentId: "default-agent",
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
        teams: [],
        teamRuns: [],
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
    const chat = hub.createChat("default-agent");
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
            configuredAgentId: "default-agent",
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
        teams: [],
        teamRuns: [],
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
      configuredAgentId: "default-agent",
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
            configuredAgentId: "default-agent",
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
        teams: [],
        teamRuns: [],
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

  test("registers an artifact for a validated file and rejects a missing one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-artifacts-"));
    await writeFile(path.join(dir, "report.md"), "# Report\nDone.", "utf8");
    const hub = new AgentHub({ codex: "codex-for-test", claude: "missing-claude-for-test" });
    hub.setWorkDir(dir);

    const ok = await (hub as any).registerArtifact({ target: "chat-1", path: "report.md", description: "final report" });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.artifact).toMatchObject({ target: "chat-1", kind: "file", title: "report.md", description: "final report" });
    expect(ok.artifact.path).toBe(path.join(dir, "report.md"));

    const snapshot = hub.snapshot() as any;
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0]).toMatchObject({ target: "chat-1", title: "report.md" });

    const missing = await (hub as any).registerArtifact({ target: "chat-1", path: "does-not-exist.md" });
    expect(missing.ok).toBe(false);
    expect((hub.snapshot() as any).artifacts).toHaveLength(1);

    const url = await (hub as any).registerArtifact({ target: "chat-1", url: "https://example.com/x", title: "Spec" });
    expect(url).toMatchObject({ ok: true, artifact: { kind: "url", url: "https://example.com/x", title: "Spec" } });
  });

  test("uses WorkflowStore as the workflow state owner", () => {
    const hub = new AgentHub();

    expect((hub as any).workflowStore).toBeDefined();
    expect("workflows" in (hub as any)).toBe(false);
    expect("workflowRuns" in (hub as any)).toBe(false);
    expect("activeWorkflowId" in (hub as any)).toBe(false);
  });

  test("persists and restores multiple workflow drafts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-"));
    const storagePath = path.join(dir, "app-chats.json");
    const hub = new AgentHub();

    await hub.loadPersistedState(storagePath);
    const first = createV2Workflow(hub, {
      configuredAgentId: "default-agent",
      title: "sample repo review",
      objective: "Review sample repo",
      graph: {
        title: "sample repo review",
        objective: "Review sample repo",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "inventory", kind: "agent", title: "Inventory", prompt: "Map repo."},
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->inventory", fromNodeId: "start", toNodeId: "inventory" },
          { id: "inventory->end", fromNodeId: "inventory", toNodeId: "end" },
        ],
      },
      messages: [
        { id: "m-1", role: "user", content: "Review sample repo" },
        { id: "m-2", role: "assistant", content: "Workflow graph ready: sample repo review" },
      ],
      reply: "looks good",
      error: undefined,
      runProgress: [{ nodeId: "inventory", title: "Inventory", status: "completed", detail: "Output captured", taskId: "task-1" }],
      runContextDocument: "# Workflow Context\n\n## Inventory (inventory)\nMapped repo.",
      contextDocument: "# Workflow Context\n\nLong lived context.",
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-1" } }),
      createdAt: 1710000000000,
      updatedAt: 1710002000000,
    });
    const planned = await (hub as any).buildWorkflowV2Plan({
      approvedBy: "planner-agent",
      definition: {
        workflowId: first.workflowId,
        graphVersion: 4,
        objective: "Persist workflow v2 planning metadata with the draft",
        nodes: [
          {
            id: "plan",
            kind: "planner",
            title: "Plan",
            execModel: "llm",
        executionMode: "one-shot",
            role: "orchestrator",
            prompt: "Plan the review",
            outputFields: [{ key: "planDoc", required: true }],
          },
          {
            id: "inventory",
            kind: "implementation",
            title: "Inventory",
            execModel: "llm",
        executionMode: "one-shot",
            prompt: "Map repo.",
            outputFields: [{ key: "inventoryDoc", required: true }],
          },
        ],
        edges: [{ fromNodeId: "plan", toNodeId: "inventory" }],
      },
    });
    hub.patchWorkflowDraft({
      workflowId: first.workflowId,
      workflowV2Plan: planned.plan!,
    });
    const second = createV2Workflow(hub, {
      title: "release workflow",
      objective: "Prepare release",
      createdAt: 1710001000000,
      updatedAt: 1710001000000,
      graph: {
        title: "release workflow",
        objective: "Prepare release",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "plan", kind: "agent", title: "Plan", prompt: "Plan release."},
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->plan", fromNodeId: "start", toNodeId: "plan" },
          { id: "plan->end", fromNodeId: "plan", toNodeId: "end" },
        ],
      },
    });
    (hub as any).selectWorkflow(first.workflowId);
    (hub as any).appendWorkflowContext({
      workflowId: first.workflowId,
      report: "Added architecture note.",
      handoff: "Use this note later.",
      artifacts: [{ kind: "text", title: "Note", content: "Architecture note." }],
    });
    await hub.flushPersistence();

    const persisted = JSON.parse(await readFile(storagePath, "utf8")) as any;
    expect(persisted.workflowStore.activeWorkflowId).toBe(first.workflowId);
    expect(persisted.workflowStore.workflows).toHaveLength(2);
    expect(persisted.workflowStore.workflows.map((workflow: any) => workflow.workflowId)).toEqual([second.workflowId, first.workflowId]);
    expect(persisted.workflowStore.workflows[1]).toMatchObject({
      title: "sample repo review",
      objective: "Review sample repo",
      revision: 3,
      contextDocument: expect.stringContaining("Added architecture note."),
      runProgress: [],
      workflowV2Plan: {
        workflowId: first.workflowId,
        graphVersion: 4,
        roleDefaults: {
          orchestrator: { role: "orchestrator", modelProfile: "expert" },
          executor: { role: "executor", modelProfile: "fast" },
        },
      },
    });

    const restored = new AgentHub();
    await restored.loadPersistedState(storagePath);
    const snapshot = restored.snapshot() as any;

    expect(snapshot.workflowStore.activeWorkflowId).toBe(first.workflowId);
    expect(snapshot.workflowStore.workflows).toHaveLength(2);
    expect(snapshot.workflowStore.workflows.map((workflow: any) => workflow.workflowId)).toEqual([second.workflowId, first.workflowId]);
    expect(snapshot.workflowStore.workflows[1]).toMatchObject({
      workflowId: first.workflowId,
      title: "sample repo review",
      objective: "Review sample repo",
      revision: 3,
      status: "draft",
      definition: { objective: "Review sample repo" },
      messages: [{ id: "m-1", role: "user" }, { id: "m-2", role: "assistant" }],
      runProgress: [],
      runContextDocument: "",
      contextDocument: expect.stringContaining("Architecture note."),
      workflowV2Plan: {
        workflowId: first.workflowId,
        graphVersion: 4,
        roleDefaults: {
          reviewer: { role: "reviewer", modelProfile: "expert" },
        },
      },
    });
  });

  test("renames a workflow draft without changing its graph", () => {
    const hub = new AgentHub();
    const created = createV2Workflow(hub, {
      title: "Original workflow",
      objective: "Review sample repo",
      graph: {
        title: "Original workflow",
        objective: "Review sample repo",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "inventory", kind: "agent", title: "Inventory", prompt: "Map repo."},
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->inventory", fromNodeId: "start", toNodeId: "inventory" },
          { id: "inventory->end", fromNodeId: "inventory", toNodeId: "end" },
        ],
      },
    });

    const snapshot = (hub as any).renameWorkflow(created.workflowId, "  Renamed workflow  ");
    const workflow = snapshot.workflowStore.workflows.find((item: any) => item.workflowId === created.workflowId);

    expect(workflow).toMatchObject({
      title: "Renamed workflow",
      objective: "Review sample repo",
      revision: 3,
      definition: { objective: "Review sample repo" },
    });
    expect(snapshot.workflowDraft.title).toBe("Renamed workflow");
  });

  test("deletes a workflow draft with its runs and selects the next remaining workflow", async () => {
    const hub = new AgentHub();
    const first = createV2Workflow(hub, {
      title: "First workflow",
      objective: "Review sample repo",
      graph: {
        title: "First workflow",
        objective: "Review sample repo",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "inventory", kind: "agent", title: "Inventory", prompt: "Map repo."},
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->inventory", fromNodeId: "start", toNodeId: "inventory" },
          { id: "inventory->end", fromNodeId: "inventory", toNodeId: "end" },
        ],
      },
    });
    const run = (hub as any).startWorkflowRun({ workflowId: first.workflowId, contextDocument: "# Run context" });
    const second = createV2Workflow(hub, {
      title: "Second workflow",
      objective: "Prepare release",
      graph: {
        title: "Second workflow",
        objective: "Prepare release",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "plan", kind: "agent", title: "Plan", prompt: "Plan release."},
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->plan", fromNodeId: "start", toNodeId: "plan" },
          { id: "plan->end", fromNodeId: "plan", toNodeId: "end" },
        ],
      },
    });
    (hub as any).selectWorkflow(first.workflowId);

    const snapshot = await (hub as any).deleteWorkflow(first.workflowId);

    expect(snapshot.workflowStore.workflows.map((workflow: any) => workflow.workflowId)).toEqual([second.workflowId]);
    expect(snapshot.workflowStore.runs.some((item: any) => item.runId === run.runId || item.workflowId === first.workflowId)).toBe(false);
    expect(snapshot.workflowStore.activeWorkflowId).toBe(second.workflowId);
    expect(snapshot.workflowDraft.workflowId).toBe(second.workflowId);
  });

  test("resets one workflow draft session without dropping other drafts", async () => {
    const hub = new AgentHub();
    const first = hub.createWorkflowDraft({ title: "First draft" }).workflowDraft!;
    const patched = hub.patchWorkflowDraft({
      workflowId: first.workflowId,
      messages: [
        { id: "m-1", role: "user", content: "Initial objective" },
        { id: "m-2", role: "assistant", content: "Initial reply" },
      ],
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-1" } }),
      contextDocument: "# Durable context",
      runContextDocument: "# Run context",
    }).workflowDraft!;
    const started = hub.startWorkflowRun({
      workflowId: patched.workflowId,
      contextDocument: "# Run context",
    });
    hub.finishWorkflowRun({
      workflowId: patched.workflowId,
      runId: started.runId!,
      status: "completed",
      progress: [{ nodeId: "plan", title: "Plan", status: "completed" }],
      finalReport: "## Final User Report\nDone.",
    });
    const second = hub.createWorkflowDraft({ title: "Second draft" }).workflowDraft!;

    const reset = await hub.resetWorkflowDraftSession(first.workflowId);
    const resetFirst = reset.workflowStore.workflows.find((workflow) => workflow.workflowId === first.workflowId);
    const preservedSecond = reset.workflowStore.workflows.find((workflow) => workflow.workflowId === second.workflowId);

    expect(reset.workflowStore.workflows).toHaveLength(2);
    expect(reset.workflowStore.activeWorkflowId).toBe(first.workflowId);
    expect(reset.workflowDraft?.workflowId).toBe(first.workflowId);
    expect(resetFirst).toMatchObject({
      workflowId: first.workflowId,
      title: "Untitled workflow",
      status: "draft",
      objective: "",
      messages: [],
      runProgress: [],
      runContextDocument: "",
      contextDocument: "",
      runIds: [],
    });
    expect(resetFirst?.finalReport).toBeUndefined();
    expect(resetFirst?.runtimeConversation).toBeUndefined();
    expect(preservedSecond).toMatchObject({
      workflowId: second.workflowId,
      title: "Second draft",
      status: "draft",
    });
  });

  test("patchWorkflowDraft clears finalReport and runtimeConversation when null is provided", () => {
    const hub = new AgentHub();
    const workflow = hub.createWorkflowDraft({ title: "Runtime workflow" }).workflowDraft!;
    hub.patchWorkflowDraft({
      workflowId: workflow.workflowId,
      finalReport: "## Final User Report\nDone.",
      runtimeConversation: runtimeConversation("codex", { native: { threadId: "thread-1" } }),
      contextDocument: "# Context",
    });

    const patched = hub.patchWorkflowDraft({
      workflowId: workflow.workflowId,
      finalReport: null,
      runtimeConversation: null,
    }).workflowDraft!;

    expect(patched.finalReport).toBeUndefined();
    expect(patched.runtimeConversation).toBeUndefined();
    expect(patched.contextDocument).toBe("# Context");
  });

  test("patchWorkflowDraft stores a workflow-v2 plan and clears it when the draft objective changes", async () => {
    const hub = new AgentHub();
    const workflow = hub.createWorkflowDraft({ title: "V2 draft" }).workflowDraft!;
    const planned = await (hub as any).buildWorkflowV2Plan({
      approvedBy: "planner-agent",
      definition: {
        workflowId: workflow.workflowId,
        graphVersion: 1,
        objective: "Route planning metadata before execution",
        nodes: [
          {
            id: "plan",
            kind: "planner",
            title: "Plan",
            execModel: "llm",
        executionMode: "one-shot",
            role: "orchestrator",
            prompt: "Plan the work",
            outputFields: [{ key: "planDoc", required: true }],
          },
          {
            id: "execute",
            kind: "implementation",
            title: "Execute",
            execModel: "llm",
        executionMode: "one-shot",
            prompt: "Implement the plan",
            outputFields: [{ key: "diff", required: true }],
          },
        ],
        edges: [{ fromNodeId: "plan", toNodeId: "execute" }],
      },
    });

    expect(planned.ok).toBe(true);
    const stored = hub.patchWorkflowDraft({
      workflowId: workflow.workflowId,
      workflowV2Plan: planned.plan!,
    }).workflowDraft!;
    expect(stored.workflowV2Plan).toMatchObject({
      workflowId: workflow.workflowId,
      graphVersion: 1,
      roleDefaults: {
        executor: { role: "executor", modelProfile: "fast" },
      },
    });

    const cleared = hub.patchWorkflowDraft({
      workflowId: workflow.workflowId,
      objective: "A changed objective invalidates the frozen plan",
    }).workflowDraft!;
    expect(cleared.workflowV2Plan).toBeUndefined();
  });

  test("keeps a running workflow status and rejects a duplicate graph run after a draft patch", () => {
    const hub = new AgentHub();
    const created = createV2Workflow(hub, {
      title: "Duplicate guard workflow",
      objective: "Do not start twice",
      graph: {
        title: "Duplicate guard workflow",
        objective: "Do not start twice",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "work", kind: "agent", title: "Work", prompt: "Work." },
          { id: "end", kind: "end", title: "End", prompt: "" },
        ],
        edges: [
          { id: "start->work", fromNodeId: "start", toNodeId: "work" },
          { id: "work->end", fromNodeId: "work", toNodeId: "end" },
        ],
      },
    });
    const started = hub.startWorkflowRun({ workflowId: created.workflowId });

    const patched = hub.patchWorkflowDraft({
      workflowId: created.workflowId,
      status: "draft",
      title: "Still running",
      resetRunState: true,
    });
    const duplicate = hub.runWorkflow({ workflowId: created.workflowId });

    expect(patched.workflowStore.workflows.find((workflow) => workflow.workflowId === created.workflowId)).toMatchObject({
      status: "running",
      title: "Still running",
      runIds: [started.runId],
    });
    expect(duplicate).toEqual({
      ok: false,
      workflowId: created.workflowId,
      error: "Workflow is already running.",
    });
    expect(hub.snapshot().workflowStore.runs.filter((run) => run.workflowId === created.workflowId)).toHaveLength(1);
    expect(started.ok).toBe(true);
  });

  test("rejects invalid V2 workflow creation with validation reasons", () => {
    const hub = new AgentHub();

    const workflowId = hub.createWorkflowDraft().workflowDraft!.workflowId;
    const result = hub.materializeWorkflowDraft(workflowId, {
      title: "Broken",
      objective: "Broken",
      definition: {
        workflowId: "broken",
        graphVersion: 1,
        objective: "Broken",
        nodes: [
          { id: "a", kind: "implementation", title: "A", execModel: "llm",
        executionMode: "one-shot", prompt: "A", outputFields: [{ key: "result", required: true }] },
          { id: "b", kind: "implementation", title: "B", execModel: "llm",
        executionMode: "one-shot", prompt: "B", outputFields: [{ key: "result", required: true }] },
        ],
        edges: [
          { fromNodeId: "a", toNodeId: "b" },
          { fromNodeId: "b", toNodeId: "a" },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("acyclic"),
    });
    expect((hub.snapshot() as any).workflowStore.workflows).toHaveLength(1);
  });

  test("rejects V2 definitions that exceed node limits", () => {
    const hub = new AgentHub();
    const nodes = [
      { id: "start", kind: "start", title: "Start", prompt: "" },
      ...Array.from({ length: 49 }, (_value, index) => ({
        id: `agent_${index}`,
        kind: "agent",
        title: `Agent ${index}`,
        prompt: "Work.",
      })),
      { id: "end", kind: "end", title: "Done", prompt: "" },
    ];
    const edges = nodes.slice(0, -1).map((node, index) => ({
      id: `${node.id}->${nodes[index + 1]!.id}`,
      fromNodeId: node.id,
      toNodeId: nodes[index + 1]!.id,
    }));

    const workflowId = hub.createWorkflowDraft().workflowDraft!.workflowId;
    const result = hub.materializeWorkflowDraft(workflowId, {
      title: "Too large",
      objective: "Too large",
      definition: {
        workflowId: "too-large",
        graphVersion: 1,
        objective: "Too large",
        nodes: Array.from({ length: 51 }, (_value, index) => ({
          id: `v2_${index}`,
          kind: "implementation",
          title: `V2 ${index}`,
          execModel: "llm",
          executionMode: "one-shot",
          prompt: "Work.",
          outputFields: [{ key: "result", required: true }],
        })),
        edges: [],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Workflow V2 definition exceeds 50 nodes.",
    });
    expect((hub.snapshot() as any).workflowStore.workflows).toHaveLength(1);
  });

  test("tracks workflow runs separately from editable workflow drafts", async () => {
    const hub = new AgentHub();
    const created = createV2Workflow(hub, {
      title: "Run tracked workflow",
      objective: "Run tracked workflow",
      graph: {
        title: "Run tracked workflow",
        objective: "Run tracked workflow",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "work", kind: "agent", title: "Work", prompt: "Work."},
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->work", fromNodeId: "start", toNodeId: "work" },
          { id: "work->end", fromNodeId: "work", toNodeId: "end" },
        ],
      },
    });
    const planned = await (hub as any).buildWorkflowV2Plan({
      approvedBy: "planner-agent",
      contextBudget: { maxContextTokens: 2800, maxEvidenceItems: 5, maxUpstreamNodes: 2 },
      definition: {
        workflowId: created.workflowId,
        graphVersion: 2,
        objective: "Carry planning metadata into the workflow run surface",
        nodes: [
          {
            id: "plan",
            kind: "planner",
            title: "Plan",
            execModel: "llm",
        executionMode: "one-shot",
            role: "orchestrator",
            prompt: "Plan the work",
            outputFields: [{ key: "planDoc", required: true }],
          },
          {
            id: "work",
            kind: "implementation",
            title: "Work",
            execModel: "llm",
        executionMode: "one-shot",
            prompt: "Work.",
            outputFields: [{ key: "diff", required: true }],
          },
        ],
        edges: [{ fromNodeId: "plan", toNodeId: "work" }],
      },
    });
    hub.patchWorkflowDraft({
      workflowId: created.workflowId,
      workflowV2Plan: planned.plan!,
    });

    const started = (hub as any).startWorkflowRun({
      workflowId: created.workflowId,
      contextDocument: "# Workflow Context\nLong lived.",
    });
    expect(started).toMatchObject({ ok: true, workflowId: created.workflowId });
    expect(started.runId).toMatch(/^run_/);

    (hub as any).appendWorkflowRunContext({
      workflowId: created.workflowId,
      runId: started.runId,
      nodeId: "work",
      report: "Finished the work.",
      handoff: "Ready for review.",
    });
    (hub as any).finishWorkflowRun({
      workflowId: created.workflowId,
      runId: started.runId,
      status: "completed",
      progress: [{ nodeId: "work", title: "Work", status: "completed" }],
      finalReport: "## Final User Report\nThe workflow completed successfully.",
    });

    const snapshot = hub.snapshot() as any;
    expect(snapshot.workflowStore.workflows[0]).toMatchObject({
      workflowId: created.workflowId,
      status: "completed",
      runIds: [started.runId],
      revision: 2,
      finalReport: "## Final User Report\nThe workflow completed successfully.",
    });
    expect(snapshot.workflowStore.runs[0]).toMatchObject({
      runId: started.runId,
      workflowId: created.workflowId,
      status: "completed",
      contextDocument: expect.stringContaining("Finished the work."),
      progress: [{ nodeId: "work", status: "completed" }],
      workflowV2Plan: {
        workflowId: created.workflowId,
        graphVersion: 2,
        budget: {
          context: { maxContextTokens: 2800, maxEvidenceItems: 5, maxUpstreamNodes: 2 },
        },
        roleDefaults: {
          orchestrator: { role: "orchestrator", modelProfile: "expert" },
          executor: { role: "executor", modelProfile: "fast" },
        },
      },
      finalReport: "## Final User Report\nThe workflow completed successfully.",
    });
    expect(snapshot.workflowStore.runs[0].workflowV2Plan.nodes[1].taskPacket).toMatchObject({
      nodeId: "work",
      role: "executor",
      modelProfile: "fast",
      budget: {
        context: { maxContextTokens: 2800, maxEvidenceItems: 5, maxUpstreamNodes: 2 },
      },
    });
  });

  test("runs a frozen Workflow V2 plan from the main process runtime without legacy judge or final review", async () => {
    const contexts: AgentExecutionContext[] = [];
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      {
        create: (context) => {
          contexts.push(context);
          return {
            start: async () => {
              const content = JSON.stringify({
                nodeId: "work",
                summary: "Worker finished through the V2 runtime.",
                outputs: { diff: "Implemented the approved change." },
                evidence: ["main runtime V2 evidence"],
                proposals: [],
              });
              context.emit({ type: "completed", content });
            },
            stop: async () => undefined,
          };
        },
      },
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex-for-test",
      version: "test",
      available: true,
    });
    const created = createV2Workflow(hub, {
      title: "Runtime workflow",
      objective: "Run from main",
      graph: {
        title: "Runtime workflow",
        objective: "Run from main",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "work", kind: "agent", title: "Work", prompt: "Do the work." },
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->work", fromNodeId: "start", toNodeId: "work" },
          { id: "work->end", fromNodeId: "work", toNodeId: "end" },
        ],
      },
    });
    const planned = await (hub as any).buildWorkflowV2Plan({
      approvedBy: "planner-agent",
      contextBudget: { maxContextTokens: 2600, maxEvidenceItems: 4, maxUpstreamNodes: 1 },
      definition: {
        workflowId: created.workflowId,
        graphVersion: 3,
        objective: "Surface V2 task packets before runtime execution begins",
        nodes: [
          {
            id: "work",
            kind: "implementation",
            title: "Work",
            execModel: "llm",
        executionMode: "one-shot",
            prompt: "Do the work.",
            outputFields: [{ key: "diff", required: true }],
            constraints: [{ key: "stay_scoped", description: "Do not invent execution behavior outside the approved plan." }],
          },
        ],
        edges: [],
      },
    });
    hub.patchWorkflowDraft({
      workflowId: created.workflowId,
      workflowV2Plan: planned.plan!,
    });

    expect(typeof (hub as any).runWorkflow).toBe("function");
    const started = await (hub as any).runWorkflow({
      workflowId: created.workflowId,
      contextDocument: "# Initial context",
    });

    expect(started).toMatchObject({ ok: true, workflowId: created.workflowId });
    const snapshot = await waitFor(
      () => hub.snapshot() as any,
      (value) => value.workflowStore.runs.some((run: any) => run.workflowId === created.workflowId && run.status === "completed"),
    );
    const run = snapshot.workflowStore.runs.find((item: any) => item.workflowId === created.workflowId);
    expect(run).toMatchObject({
      status: "completed",
      progress: [
        expect.objectContaining({ nodeId: "work", status: "completed" }),
      ],
      contextDocument: expect.stringContaining("# Initial context"),
      finalReport: expect.stringContaining("# Workflow V2 Run Summary"),
    });
    expect(snapshot.workflowStore.workflows.find((item: any) => item.workflowId === created.workflowId)).toMatchObject({
      status: "completed",
      finalReport: expect.stringContaining("Worker finished through the V2 runtime."),
    });
    expect(contexts.map((context) => context.runKind)).toEqual(["task"]);
    expect(contexts[0]?.prompt).toBe("Do the work.");
    expect(contexts[0]?.developerInstructions).toContain("Workflow V2 task packet");
    expect(contexts[0]?.developerInstructions).toContain('"role": "executor"');
    expect(contexts[0]?.developerInstructions).toContain('"modelProfile": "fast"');
    expect(contexts[0]?.developerInstructions).toContain("Do not invent execution behavior outside the approved plan.");
    expect(contexts[0]?.developerInstructions).toContain('"maxContextTokens": 2600');
    expect(contexts[0]?.developerInstructions).toContain('"upstreamOutputs": []');
    expect(contexts[0]?.prompt).not.toContain("workflow judge");
    expect(contexts[0]?.prompt).not.toContain("main workflow agent");

    const eventTypesForWork = run.events.filter((event: any) => event.nodeId === "work").map((event: any) => event.type);
    expect(eventTypesForWork).toEqual(["node_started", "node_output", "node_completed"]);
    expect(run.events.some((event: any) => event.nodeId === "__final_review__")).toBe(false);
    const projected = projectNodeStates(run.events, [{ nodeId: "work", title: "Work" }]);
    expect(projected.map((item) => ({ nodeId: item.nodeId, status: item.status }))).toEqual(
      run.progress.map((item: any) => ({ nodeId: item.nodeId, status: item.status })),
    );
  });

  test("runs a safe Workflow V2 script node without user approval", async () => {
    const hub = new AgentHub({ codex: "codex-for-test", claude: "missing-claude-for-test" });
    const created = createV2Workflow(hub, {
      title: "Safe script workflow",
      objective: "Run a pure in-memory script",
      graph: {
        title: "Legacy graph is not executed",
        objective: "Legacy graph is not executed",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "legacy", kind: "agent", title: "Legacy", prompt: "Must not run." },
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->legacy", fromNodeId: "start", toNodeId: "legacy" },
          { id: "legacy->end", fromNodeId: "legacy", toNodeId: "end" },
        ],
      },
    });
    const planned = await (hub as any).buildWorkflowV2Plan({
      approvedBy: "planner-agent",
      definition: {
        workflowId: created.workflowId,
        graphVersion: 1,
        objective: "Exercise automatic safe script authorization",
        nodes: [{
          id: "script",
          kind: "verification",
          title: "Script",
          execModel: "script",
          executionMode: "script",
          script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { result: 'ok' };", timeoutMs: 1_000, outputSchema: { type: "object", required: ["result"] } }),
          outputFields: [{ key: "result", required: true }],
        }],
        edges: [],
      },
    });
    hub.patchWorkflowDraft({ workflowId: created.workflowId, workflowV2Plan: planned.plan! });
    const route = hub.snapshot().workflowDraft!;
    hub.patchWorkflowDraft({ workflowId: created.workflowId, generationReview: { status: "approved", reviewerConfiguredAgentId: route.reviewerConfiguredAgentId, reviewerModelId: route.reviewerModelId, reviewedRevision: route.revision, result: { verdict: "approve", reviewedRevision: route.revision, summary: "Approved safe script", findings: [], scriptRisks: { script: { level: "safe", rationale: "Pure in-memory transformation." } }, suggestions: [] }, updatedAt: 1 } });
    hub.confirmWorkflow({ workflowId: created.workflowId, expectedRevision: route.revision });

    const started = await (hub as any).runWorkflow({ workflowId: created.workflowId });
    const snapshot = await waitFor(
      () => hub.snapshot() as any,
      (value) => value.workflowStore.runs.some((run: any) => run.workflowId === created.workflowId && run.status === "completed"),
    );
    const run = snapshot.workflowStore.runs.find((item: any) => item.runId === started.runId);

    expect(run).toMatchObject({ status: "completed", progress: [{ nodeId: "script", status: "completed", detail: "Script completed." }] });
    expect(run.events.filter((event: any) => event.nodeId === "script").map((event: any) => event.type)).toEqual(["node_started", "node_output", "node_completed"]);
  });
  test("pauses a running workflow node without evaluating it or starting downstream nodes", async () => {
    const contexts: AgentExecutionContext[] = [];
    let stopCount = 0;
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      {
        create: (context) => {
          contexts.push(context);
          return {
            start: async () => new Promise<void>(() => undefined),
            stop: async () => {
              stopCount += 1;
            },
          };
        },
      },
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex-for-test",
      version: "test",
      available: true,
    });
    const created = createV2Workflow(hub, {
      title: "Pausable workflow",
      objective: "Pause one node",
      definition: {
        workflowId: "wf_pausable",
        graphVersion: 1,
        objective: "Pause one node",
        nodes: [
          { id: "work", kind: "implementation", title: "Work", execModel: "llm",
        executionMode: "one-shot", prompt: "Do the work.", outputFields: [{ key: "result", required: true }] },
          { id: "followup", kind: "implementation", title: "Follow up", execModel: "llm",
        executionMode: "one-shot", prompt: "Use the work output.", outputFields: [{ key: "result", required: true }] },
        ],
        edges: [{ fromNodeId: "work", toNodeId: "followup" }],
      },
      graph: {
        title: "Pausable workflow",
        objective: "Pause one node",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "work", kind: "agent", title: "Work", prompt: "Do the work." },
          { id: "followup", kind: "agent", title: "Follow up", prompt: "Use the work output." },
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->work", fromNodeId: "start", toNodeId: "work" },
          { id: "work->followup", fromNodeId: "work", toNodeId: "followup" },
          { id: "followup->end", fromNodeId: "followup", toNodeId: "end" },
        ],
      },
    });
    const started = (hub as any).runWorkflow({ workflowId: created.workflowId });
    expect(started).toMatchObject({ ok: true });
    await waitFor(
      () => hub.snapshot() as any,
      (value) => value.workflowStore.runs.some((run: any) => run.runId === started.runId && run.progress.some((item: any) => item.nodeId === "work" && item.status === "running" && item.taskId)),
    );

    expect(typeof (hub as any).pauseWorkflowNode).toBe("function");
    const paused = await (hub as any).pauseWorkflowNode({
      workflowId: created.workflowId,
      runId: started.runId,
      nodeId: "work",
    });

    expect(paused).toMatchObject({ ok: true, workflowId: created.workflowId, runId: started.runId });
    const snapshot = hub.snapshot() as any;
    const run = snapshot.workflowStore.runs.find((item: any) => item.runId === started.runId);
    expect(run.progress).toEqual([
      expect.objectContaining({ nodeId: "work", status: "paused" }),
      expect.objectContaining({ nodeId: "followup", status: "queued" }),
    ]);
    // Pausing the only running node keeps the run resumable for human revision.
    expect(run.status).toBe("waiting_for_user");
    expect(snapshot.workflowStore.workflows.find((w: any) => w.workflowId === created.workflowId).status).toBe("waiting_for_user");
    expect(stopCount).toBe(1);
    expect(contexts).toHaveLength(1);
  });

  test("starts a paused workflow node and continues downstream execution", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-workflow-v2-resume-"));
    const storagePath = path.join(dir, "app-state.json");
    const contexts: AgentExecutionContext[] = [];
    let stopCount = 0;
    let hangingStarted = false;
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      {
        create: (context) => {
          contexts.push(context);
          const countsAsPauseStop = !hangingStarted && context.prompt === "Do the work.";
          return {
            start: async () => {
              if (!hangingStarted && context.prompt === "Do the work.") {
                hangingStarted = true;
                return new Promise<void>(() => undefined);
              }
              const content = context.prompt === "Use the work output."
                ? JSON.stringify({ nodeId: "followup", summary: "Follow-up finished.", outputs: { result: "done" }, proposals: [] })
                : JSON.stringify({ nodeId: "work", summary: "Work finished after resume.", outputs: { result: "ready" }, proposals: [] });
              context.emit({ type: "completed", content });
            },
            stop: async () => {
              if (countsAsPauseStop) stopCount += 1;
            },
          };
        },
      },
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex-for-test",
      version: "test",
      available: true,
    });
    await hub.loadPersistedState(storagePath);
    const created = createV2Workflow(hub, {
      title: "Resume node workflow",
      objective: "Resume one node",
      definition: {
        workflowId: "wf_resume_node",
        graphVersion: 1,
        objective: "Resume one node",
        nodes: [
          { id: "work", kind: "implementation", title: "Work", execModel: "llm",
        executionMode: "one-shot", prompt: "Do the work.", outputFields: [{ key: "result", required: true }] },
          { id: "followup", kind: "implementation", title: "Follow up", execModel: "llm",
        executionMode: "one-shot", prompt: "Use the work output.", outputFields: [{ key: "result", required: true }] },
        ],
        edges: [{ fromNodeId: "work", toNodeId: "followup" }],
      },
      graph: {
        title: "Resume node workflow",
        objective: "Resume one node",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "work", kind: "agent", title: "Work", prompt: "Do the work." },
          { id: "followup", kind: "agent", title: "Follow up", prompt: "Use the work output." },
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->work", fromNodeId: "start", toNodeId: "work" },
          { id: "work->followup", fromNodeId: "work", toNodeId: "followup" },
          { id: "followup->end", fromNodeId: "followup", toNodeId: "end" },
        ],
      },
    });
    const started = (hub as any).runWorkflow({ workflowId: created.workflowId });
    await waitFor(
      () => hub.snapshot() as any,
      (value) => value.workflowStore.runs.some((run: any) => run.runId === started.runId && run.progress.some((item: any) => item.nodeId === "work" && item.status === "running" && item.taskId)),
    );
    await (hub as any).pauseWorkflowNode({
      workflowId: created.workflowId,
      runId: started.runId,
      nodeId: "work",
    });

    expect(typeof (hub as any).startWorkflowNode).toBe("function");
    const resumed = await (hub as any).startWorkflowNode({
      workflowId: created.workflowId,
      runId: started.runId,
      nodeId: "work",
    });

    expect(resumed).toMatchObject({ ok: true, workflowId: created.workflowId, runId: started.runId });
    const snapshot = await waitFor(
      () => hub.snapshot() as any,
      (value) => value.workflowStore.runs.some((run: any) => run.runId === started.runId && run.status === "completed"),
    );
    const run = snapshot.workflowStore.runs.find((item: any) => item.runId === started.runId);
    expect(run).toMatchObject({
      status: "completed",
      finalReport: expect.stringContaining("Status: completed"),
    });
    expect(run.progress).toEqual([
      expect.objectContaining({ nodeId: "work", status: "completed" }),
      expect.objectContaining({ nodeId: "followup", status: "completed" }),
    ]);
    expect(stopCount).toBe(1);
    expect(contexts.map((context) => context.prompt === "Use the work output." ? "followup" : "work")).toEqual([
      "work",
      "work",
      "followup",
    ]);
  });

  test("keeps a completed interactive node open until the user confirms it", async () => {
    let interactiveContext: any;
    const session = {
      reconfigure: vi.fn(),
      ensureAttached: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => {
        interactiveContext.emit({ type: "delta", content: JSON.stringify({ nodeId: "work", summary: "Done", outputs: { result: "finished" }, evidence: [], risks: [], proposals: [] }) });
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
    const runtimeDrivers = new RuntimeDriverRegistry([{
      runtimeId: "codex",
      surfaceSupport: [support("chat", ["interactive"], ["fresh", "resume-preferred", "resume-required"])],
      runtimeStateCodec: codexRuntimeStateCodec,
      getCapabilities: () => interactiveChatCapabilities("codex"),
      createOneShotExecutor: () => ({ start: async () => undefined, stop: async () => undefined }),
      createInteractiveSession: (context: any) => { interactiveContext = context; return session; },
    } as any]);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      undefined,
      runtimeDrivers,
    );
    const completeInteractiveNode = vi.spyOn((hub as any).workflowRuntime, "completeInteractiveNode");
    (hub as any).runtimes.set("codex", { id: "codex", label: "Codex", command: "codex", version: "test", available: true });
    const configuredAgentId = hub.snapshot().configuredAgents.find((agent) => agent.runtimeAgentId === "codex")!.id;
    const created = createV2Workflow(hub, {
      configuredAgentId,
      title: "Confirmation workflow",
      objective: "Wait for confirmation",
      definition: {
        workflowId: "wf_confirmation",
        graphVersion: 1,
        objective: "Wait for confirmation",
        nodes: [{ id: "work", kind: "implementation", title: "Work", execModel: "llm", executionMode: "interactive", prompt: "Do the work.", outputFields: [{ key: "result", required: true }] }],
        edges: [],
      },
      graph: {
        title: "Confirmation workflow",
        objective: "Wait for confirmation",
        nodes: [{ id: "start", kind: "start", title: "Start", prompt: "" }, { id: "work", kind: "agent", title: "Work", prompt: "Do the work." }, { id: "end", kind: "end", title: "Done", prompt: "" }],
        edges: [{ id: "start->work", fromNodeId: "start", toNodeId: "work" }, { id: "work->end", fromNodeId: "work", toNodeId: "end" }],
      },
    });

    const started = (hub as any).runWorkflow({ workflowId: created.workflowId });
    await waitFor(
      () => hub.snapshot(),
      (snapshot) => snapshot.workflowNodeConversations.some((conversation) => conversation.runId === started.runId),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const snapshot = hub.snapshot();
    expect(completeInteractiveNode).not.toHaveBeenCalled();
    expect(snapshot.workflowNodeConversations.find((conversation) => conversation.runId === started.runId)).toMatchObject({ status: "completion_proposed" });
    expect(snapshot.workflowStore.runs.find((run) => run.runId === started.runId)?.status).toBe("waiting_for_user");
  });

  test("projects an unavailable interactive conversation as awaiting input", async () => {
    const contexts: AgentExecutionContext[] = [];
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      {
        create: (context) => {
          contexts.push(context);
          return {
            start: async () => {
              context.emit({ type: "completed", content: "Persistent interactive session unavailable." });
            },
            stop: async () => undefined,
          };
        },
      },
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex-for-test",
      version: "test",
      available: true,
    });
    const created = createV2Workflow(hub, {
      title: "Gate workflow",
      objective: "Ask a human when needed",
      definition: {
        workflowId: "wf_gate",
        graphVersion: 1,
        objective: "Ask a human when needed",
        nodes: [
          { id: "work", kind: "implementation", title: "Work", execModel: "llm",
        executionMode: "interactive", prompt: "Ask the user which environment to deploy to, then finish the work.", outputFields: [{ key: "result", required: true }] },
        ],
        edges: [],
      },
      graph: {
        title: "Gate workflow",
        objective: "Ask a human when needed",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "work", kind: "agent", title: "Work", prompt: "Do the work." },
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->work", fromNodeId: "start", toNodeId: "work" },
          { id: "work->end", fromNodeId: "work", toNodeId: "end" },
        ],
      },
    });
    const started = (hub as any).runWorkflow({ workflowId: created.workflowId });

    const pausedSnapshot = await waitFor(
      () => hub.snapshot() as any,
      (value) =>
        value.workflowStore.runs.some(
          (run: any) => run.runId === started.runId && run.progress.some((item: any) => item.nodeId === "work" && item.status === "awaiting_input"),
        ),
    );
    const pausedRun = pausedSnapshot.workflowStore.runs.find((item: any) => item.runId === started.runId);
    expect(pausedRun.status).toBe("waiting_for_user");
    expect(pausedRun.progress.find((item: any) => item.nodeId === "work")).toMatchObject({
      status: "awaiting_input",
    });
    expect(pausedRun.events.some((event: any) => event.type === "gate_opened" && event.nodeId === "work")).toBe(true);
    expect(contexts).toHaveLength(0);
  });

  test("persists scheduled workflow config, schedules, and run history", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-scheduled-workflows-"));
    const storagePath = path.join(dir, "app-state.json");
    const hub = new AgentHub();
    await hub.loadPersistedState(storagePath);

    const created = createV2Workflow(hub, {
      title: "Daily repo review",
      objective: "Review repository changes every morning",
      graph: {
        title: "Daily repo review",
        objective: "Review repository changes every morning",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "review", kind: "agent", title: "Review", prompt: "Review recent changes."},
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->review", fromNodeId: "start", toNodeId: "review" },
          { id: "review->end", fromNodeId: "review", toNodeId: "end" },
        ],
      },
    });

    (hub as any).saveScheduledWorkflowRunnerConfig({
      baseUrl: "https://scheduler.example.com",
      deviceId: "device-local",
      runnerToken: "runner-token",
    });
    const upserted = (hub as any).upsertScheduledWorkflowSchedule({
      scheduleId: "sched_daily_review",
      workflowId: created.workflowId,
      title: "Daily repo review",
      enabled: true,
      intervalSeconds: 86400,
      frequency: "daily",
      timeOfDay: "09:00",
      timezone: "Asia/Shanghai",
      nextRunAt: 1710003600000,
      lastRunAt: undefined,
      source: "cloud",
      createdAt: 1710000000000,
      updatedAt: 1710000000000,
    });
    expect(upserted).toMatchObject({ ok: true, scheduleId: "sched_daily_review" });

    const runningSnapshot = (hub as any).recordScheduledWorkflowRun({
      runId: "scheduled_run_1",
      scheduleId: "sched_daily_review",
      workflowId: created.workflowId,
      eventId: "event_1",
      title: "Daily repo review",
      status: "running",
      startedAt: 1710003600000,
      finishedAt: undefined,
      message: "Runner started workflow.",
    });
    expect(runningSnapshot.scheduledWorkflowStore.runs[0]).toMatchObject({
      runId: "scheduled_run_1",
      status: "running",
      eventId: "event_1",
    });

    (hub as any).finishScheduledWorkflowRun("scheduled_run_1", {
      status: "completed",
      workflowRunId: "run_workflow_1",
      message: "Workflow completed.",
      finishedAt: 1710003900000,
    });
    await hub.flushPersistence();

    const persisted = JSON.parse(await readFile(storagePath, "utf8")) as any;
    expect(persisted.scheduledWorkflowStore.runnerConfig).toMatchObject({
      baseUrl: "https://scheduler.example.com",
      deviceId: "device-local",
      runnerToken: "runner-token",
    });
    expect(persisted.scheduledWorkflowStore.schedules).toHaveLength(1);
    expect(persisted.scheduledWorkflowStore.runs[0]).toMatchObject({
      runId: "scheduled_run_1",
      scheduleId: "sched_daily_review",
      status: "completed",
      workflowRunId: "run_workflow_1",
    });

    const restored = new AgentHub();
    await restored.loadPersistedState(storagePath);
    const snapshot = restored.snapshot() as any;

    expect(snapshot.scheduledWorkflowStore.runnerConfig).toMatchObject({
      baseUrl: "https://scheduler.example.com",
      deviceId: "device-local",
      runnerToken: "runner-token",
    });
    expect(snapshot.scheduledWorkflowStore.schedules[0]).toMatchObject({
      scheduleId: "sched_daily_review",
      workflowId: created.workflowId,
      title: "Daily repo review",
      enabled: true,
      intervalSeconds: 86400,
      frequency: "daily",
      timeOfDay: "09:00",
      timezone: "Asia/Shanghai",
      nextRunAt: 1710003600000,
      source: "cloud",
    });
    expect(snapshot.scheduledWorkflowStore.runs[0]).toMatchObject({
      runId: "scheduled_run_1",
      status: "completed",
      workflowRunId: "run_workflow_1",
      message: "Workflow completed.",
    });
  });

  test("runs a scheduled workflow event in main and acks after local completion", async () => {
    const contexts: AgentExecutionContext[] = [];
    const ackEvent = vi.fn(async () => undefined);
    const hub = new AgentHub(
      { codex: "codex-for-test", claude: "missing-claude-for-test" },
      {
        create: (context) => {
          contexts.push(context);
          return {
            start: async () => {
              const content = context.prompt.includes("workflow judge")
                ? 'workflowEvaluation.submit({ complete: true, reason: "approved", retryPrompt: "" })'
                : context.prompt.includes("main workflow agent")
                  ? "## Final User Report\nScheduled workflow completed."
                  : "### Work Completion Report\nScheduled work finished.\n\n### Handoff\nReady.";
              context.emit({ type: "completed", content });
            },
            stop: async () => undefined,
          };
        },
      },
    );
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: "codex-for-test",
      version: "test",
      available: true,
    });
    const created = createV2Workflow(hub, {
      title: "Scheduled workflow",
      objective: "Run from scheduled event",
      definition: {
        workflowId: "wf_scheduled",
        graphVersion: 1,
        objective: "Run from scheduled event",
        nodes: [
          { id: "work", kind: "implementation", title: "Work", execModel: "llm",
        executionMode: "one-shot", prompt: "Do the scheduled work.", outputFields: [{ key: "result", required: true }] },
        ],
        edges: [],
      },
      graph: {
        title: "Scheduled workflow",
        objective: "Run from scheduled event",
        nodes: [
          { id: "start", kind: "start", title: "Start", prompt: "" },
          { id: "work", kind: "agent", title: "Work", prompt: "Do the scheduled work." },
          { id: "end", kind: "end", title: "Done", prompt: "" },
        ],
        edges: [
          { id: "start->work", fromNodeId: "start", toNodeId: "work" },
          { id: "work->end", fromNodeId: "work", toNodeId: "end" },
        ],
      },
    });
    (hub as any).upsertScheduledWorkflowSchedule({
      scheduleId: "sched_1",
      workflowId: created.workflowId,
      title: "Scheduled workflow",
      enabled: true,
      intervalSeconds: 86400,
      frequency: "daily",
      timeOfDay: "09:00",
      timezone: "Asia/Shanghai",
      source: "cloud",
      createdAt: 1710000000000,
      updatedAt: 1710000000000,
    });

    await hub.runScheduledWorkflowEvent({
      eventId: "event_1",
      type: "scheduled.workflow.due",
      title: "Scheduled workflow",
      message: "Cloud runner triggered this workflow.",
      payload: {
        scheduleId: "sched_1",
        workflowId: created.workflowId,
      },
    }, ackEvent);

    const snapshot = hub.snapshot() as any;
    expect(snapshot.scheduledWorkflowStore.runs[0]).toMatchObject({
      runId: "scheduled_run_event_1",
      scheduleId: "sched_1",
      workflowId: created.workflowId,
      status: "completed",
      message: "Workflow completed.",
      workflowRunId: expect.stringMatching(/^run_/),
    });
    expect(snapshot.workflowStore.runs.find((run: any) => run.runId === snapshot.scheduledWorkflowStore.runs[0].workflowRunId)).toMatchObject({
      workflowId: created.workflowId,
      status: "completed",
      finalReport: expect.stringContaining("Status: completed"),
    });
    expect(ackEvent).toHaveBeenCalledTimes(1);
    expect(ackEvent).toHaveBeenCalledWith("event_1", expect.objectContaining({
      status: "completed",
      workflowRunId: snapshot.scheduledWorkflowStore.runs[0].workflowRunId,
      message: "Workflow completed.",
    }));
    expect(contexts).toHaveLength(1);
  });

  test("rejects schedules for missing workflows", () => {
    const hub = new AgentHub();

    const result = (hub as any).upsertScheduledWorkflowSchedule({
      scheduleId: "sched_missing",
      workflowId: "wf_missing",
      title: "Missing workflow",
      enabled: true,
      intervalSeconds: 3600,
      frequency: "daily",
      timeOfDay: "09:00",
      timezone: "Asia/Shanghai",
      source: "cloud",
      createdAt: 1710000000000,
      updatedAt: 1710000000000,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Workflow wf_missing was not found.",
    });
    expect((hub.snapshot() as any).scheduledWorkflowStore.schedules).toEqual([]);
  });
});

describe("AgentHub task runs", () => {
  test("creates a task run with selected execution config without changing the active chat", async () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    const activeChatId = hub.snapshot().activeChatId;

    const snapshot = await hub.runTask({
      prompt: "Inspect the repo and summarize risks",
      configuredAgentId: "default-agent",
      workDir: "/tmp/project",
    });

    expect(snapshot.activeChatId).toBe(activeChatId);
    expect(snapshot.activeTaskId).toBe(snapshot.tasks[0]?.id);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      title: "Inspect the repo and summarize risks",
      prompt: "Inspect the repo and summarize risks",
      configuredAgentId: "default-agent",
      workDir: "/tmp/project",
      progress: "todo",
      status: "failed",
      running: false,
      messages: [
        expect.objectContaining({ role: "user", content: "Inspect the repo and summarize risks" }),
        expect.objectContaining({ role: "error", content: "Codex OpenAI is not available on this machine." }),
      ],
      });
    });

  test("keeps task execution explicitly oneshot even when driver task support advertises interactive only", async () => {
      const executorCalls: any[] = [];
      const executorFactory: AgentExecutorFactory = {
        create: (context: any) => ({
          start: async () => {
            executorCalls.push(context);
            context.emit({ type: "delta", content: "task response" });
            context.emit({ type: "completed" });
          },
          stop: async () => undefined,
        }),
      };
      const runtimeDrivers = new RuntimeDriverRegistry([
        {
          runtimeId: "codex",
          surfaceSupport: [
            support("chat", ["oneshot"], ["fresh"]),
            support("task", ["interactive"], ["fresh", "resume-preferred"]),
          ],
          runtimeStateCodec: codexRuntimeStateCodec,
          getCapabilities: () => interactiveChatCapabilities("codex"),
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

      const snapshot = await hub.runTask({
        prompt: "Inspect the repo and summarize risks",
        configuredAgentId: "default-agent",
        workDir: "/tmp/project",
      });
      const taskId = snapshot.activeTaskId!;
      const task = await waitFor(
        () => hub.snapshot().tasks.find((item) => item.id === taskId),
        (item) => item?.running === false,
      );

      expect(executorCalls).toHaveLength(1);
      expect(executorCalls[0]).toMatchObject({
        runKind: "task",
        executionMode: "oneshot",
        continuationPolicy: "fresh",
        runtimeConfig: { model: DEFAULT_MODEL_ID },
        prompt: "Inspect the repo and summarize risks",
      });
      expect(task?.messages).toEqual([
        expect.objectContaining({ role: "user", content: "Inspect the repo and summarize risks" }),
        expect.objectContaining({ role: "assistant", content: "task response" }),
      ]);
  });

  test("runs an internal task with an explicitly resumed runtime conversation", async () => {
    const executorCalls: any[] = [];
    const executorFactory: AgentExecutorFactory = {
      create: (context: any) => ({
        start: async () => {
          executorCalls.push(context);
          context.emit({ type: "delta", content: "progress report" });
          context.emit({ type: "completed" });
        },
        stop: async () => undefined,
      }),
    };
    const runtimeDrivers = new RuntimeDriverRegistry([
      {
        runtimeId: "codex",
        surfaceSupport: [
          support("chat", ["oneshot"], ["fresh"]),
          support("task", ["oneshot"], ["fresh", "resume-required"]),
        ],
        runtimeStateCodec: codexRuntimeStateCodec,
        getCapabilities: () => interactiveChatCapabilities("codex"),
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
    const conversation = runtimeConversation("codex", { native: { threadId: "workflow-task-thread" } });

    const snapshot = await hub.runTask({
      prompt: "Report structured workflow progress",
      configuredAgentId: "default-agent",
      workDir: "/tmp/project",
      continuationPolicy: "resume-required",
      runtimeConversation: conversation,
    });
    const taskId = snapshot.activeTaskId!;
    await waitFor(
      () => hub.snapshot().tasks.find((item) => item.id === taskId),
      (item) => item?.running === false,
    );

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toMatchObject({
      runKind: "task",
      executionMode: "oneshot",
      continuationPolicy: "resume-required",
      runtimeConversation: conversation,
      prompt: "Report structured workflow progress",
    });
    expect(executorCalls[0].runtimeConversation).not.toBe(conversation);
  });

  test("keeps user progress separate from agent execution status", () => {
    const hub = new AgentHub();
    const task = (hub as any).createTaskState({
      prompt: "Run a focused task",
      configuredAgentId: "default-agent",
      workDir: "/tmp/project",
    });
    (hub as any).tasks.set(task.id, task);
    hub.selectTask(task.id);

    let snapshot = hub.updateTaskProgress(task.id, "done");
    expect(snapshot.tasks[0]).toMatchObject({
      id: task.id,
      progress: "done",
      status: "queued",
    });

    (hub as any).handleAgentEvent(task, { type: "delta", content: "Working" });
    snapshot = hub.snapshot();
    expect(snapshot.tasks[0]).toMatchObject({
      progress: "done",
      status: "queued",
    });

    (hub as any).handleAgentEvent(task, { type: "completed" });
    snapshot = hub.snapshot();
    expect(snapshot.tasks[0]).toMatchObject({
      progress: "in_review",
      status: "completed",
    });
  });

  test("stores task transcript events separately from chat transcript", () => {
    const hub = new AgentHub();
    const task = (hub as any).createTaskState({
      prompt: "Run a focused task",
      configuredAgentId: "default-agent",
      workDir: "/tmp/project",
    });
    (hub as any).tasks.set(task.id, task);
    (hub as any).handleAgentEvent(task, { type: "delta", content: "Working" });
    (hub as any).handleAgentEvent(task, { type: "meta", content: "鈫?shell_command\npwd" });
    (hub as any).handleAgentEvent(task, { type: "completed" });

    const snapshot = hub.snapshot();
    expect(snapshot.tasks[0]?.status).toBe("completed");
    expect(snapshot.tasks[0]?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Working",
        events: [expect.objectContaining({ type: "meta", content: "鈫?shell_command\npwd" })],
      }),
    ]);
    expect(snapshot.chats[0]?.messages).toEqual([]);
  });

  test("deletes a task run and selects the next remaining task", async () => {
    const hub = new AgentHub();
    const first = (hub as any).createTaskState({
      prompt: "First task",
      configuredAgentId: "default-agent",
      workDir: "/tmp/project",
    });
    const second = (hub as any).createTaskState({
      prompt: "Second task",
      configuredAgentId: "default-agent",
      workDir: "/tmp/project",
    });
    (hub as any).tasks.set(first.id, first);
    (hub as any).tasks.set(second.id, second);
    hub.selectTask(first.id);

    const snapshot = await (hub as any).deleteTask(first.id);

    expect(snapshot.tasks.map((task: any) => task.id)).toEqual([second.id]);
    expect(snapshot.activeTaskId).toBe(second.id);
  });

  test("archives the Codex session when deleting a task with a runtime conversation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-archive-"));
    const argsPath = path.join(dir, "args.txt");
    const executable = await writeNodeCliLauncher(
      dir,
      "codex-fake",
      `const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, process.argv.slice(2).join("\\n") + "\\n", "utf8");
`,
    );

    const hub = new AgentHub({ codex: executable, claude: "missing-claude-for-test" });
    const task = (hub as any).createTaskState({
      prompt: "Task with session",
      configuredAgentId: "default-agent",
      workDir: "/tmp/project",
    });
    task.runtimeConversation = runtimeConversation("codex", {
      native: { threadId: "019e9143-2451-7612-a62d-e65389574d7d" },
    });
    (hub as any).tasks.set(task.id, task);

    await hub.deleteTask(task.id);

    expect(await readFile(argsPath, "utf8")).toBe("archive\n019e9143-2451-7612-a62d-e65389574d7d\n");
  });

  test("can delete an internal workflow task without archiving a conversation needed for resume", async () => {
    const hub = new AgentHub();
    const task = (hub as any).createTaskState({
      prompt: "Progress probe source task",
      configuredAgentId: "default-agent",
      workDir: "/tmp/project",
    });
    task.runtimeConversation = runtimeConversation("codex", {
      native: { threadId: "workflow-resume-thread" },
    });
    (hub as any).tasks.set(task.id, task);
    const deleteAgentSession = vi.spyOn(hub as any, "deleteAgentSession");

    const snapshot = await hub.deleteTask(task.id, { preserveRuntimeConversation: true });

    expect(snapshot.tasks.some((item) => item.id === task.id)).toBe(false);
    expect(deleteAgentSession).not.toHaveBeenCalled();
  });
});

describe("AgentHub agent teams", () => {
  test("creates an agent team with ordered members and shared context", () => {
    const hub = new AgentHub();

    const snapshot = (hub as any).createTeam({
      name: "Review Team",
      sharedContext: "Focus on repo risks and public dependencies.",
      members: [
        {
          roleName: "Reviewer",
          prompt: "Review the implementation for correctness.",
          configuredAgentId: "default-agent",
          canvasPosition: { x: 120, y: 90 },
        },
        {
          roleName: "Verifier",
          configuredAgentId: "default-agent",
        },
      ],
    });

    expect(snapshot.activeTeamId).toBe(snapshot.teams[0]?.id);
    expect(snapshot.teams[0]).toMatchObject({
      name: "Review Team",
      mode: "pipeline",
      sharedContext: "Focus on repo risks and public dependencies.",
      members: [
        expect.objectContaining({
          roleName: "Reviewer",
          prompt: "Review the implementation for correctness.",
          configuredAgentId: "default-agent",
          canvasPosition: { x: 120, y: 90 },
        }),
        expect.objectContaining({ roleName: "Verifier"}),
      ],
    });
    const [reviewer, verifier] = snapshot.teams[0]!.members;
    expect(snapshot.teams[0]!.workflow).toMatchObject({
      mode: "pipeline",
      phases: [
        expect.objectContaining({ title: "Start" }),
        expect.objectContaining({ title: "Reviewer" }),
        expect.objectContaining({ title: "Verifier" }),
        expect.objectContaining({ title: "Done" }),
      ],
      nodes: [
        expect.objectContaining({ id: "start", kind: "start", label: "Start", status: "idle" }),
        expect.objectContaining({
          id: `member:${reviewer!.id}`,
          kind: "agent",
          label: "Reviewer",
          teamMemberId: reviewer!.id,
          status: "idle",
          canvasPosition: { x: 120, y: 90 },
        }),
        expect.objectContaining({ id: `member:${verifier!.id}`, kind: "agent", label: "Verifier", teamMemberId: verifier!.id, status: "idle" }),
        expect.objectContaining({ id: "done", kind: "done", label: "Done", status: "idle" }),
      ],
      edges: [
        expect.objectContaining({ fromNodeId: "start", toNodeId: `member:${reviewer!.id}` }),
        expect.objectContaining({ fromNodeId: `member:${reviewer!.id}`, toNodeId: `member:${verifier!.id}` }),
        expect.objectContaining({ fromNodeId: `member:${verifier!.id}`, toNodeId: "done" }),
      ],
    });
  });

  test("preserves agent team member canvas positions when updating members", () => {
    const hub = new AgentHub();
    const created = (hub as any).createTeam({
      name: "Layout Team",
      members: [
        {
          id: "member-a",
          roleName: "Planner",
          prompt: "Plan",
          configuredAgentId: "default-agent",
        },
      ],
    });
    const teamId = created.teams[0]!.id;

    const updated = (hub as any).updateTeam(teamId, {
      members: [
        {
          ...created.teams[0]!.members[0],
          canvasPosition: { x: 240, y: 180 },
        },
      ],
    });

    expect(updated.teams[0]!.members[0]!.canvasPosition).toEqual({ x: 240, y: 180 });
  });

  test("runs a parallel team by starting all members at once", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-team-parallel-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });

    const created = (hub as any).createTeam({
      name: "Parallel Review",
      mode: "parallel",
      sharedContext: "Shared parallel context",
      members: [
        {
          roleName: "Security",
          prompt: "Check auth and dependency risks.",
          configuredAgentId: "default-agent",
        },
        {
          roleName: "Testing",
          prompt: "Check missing verification and flaky tests.",
          configuredAgentId: "default-agent",
        },
      ],
    });
    const teamId = created.teams[0].id;

    const started = await (hub as any).runTeam({
      teamId,
      prompt: "Review the release branch",
      target: { kind: "workspace", label: "Current workspace", value: dir },
      workDir: dir,
    });

    expect(started.teamRuns[0]).toMatchObject({
      teamId,
      teamName: "Parallel Review",
      mode: "parallel",
      status: "running",
      target: { kind: "workspace", label: "Current workspace", value: dir },
      steps: [
        expect.objectContaining({ roleName: "Security", status: "running" }),
        expect.objectContaining({ roleName: "Testing", status: "running" }),
      ],
    });
    expect(started.teamRuns[0].steps[0].taskId).toBeDefined();
    expect(started.teamRuns[0].steps[1].taskId).toBeDefined();
    expect(started.teamRuns[0].steps[1].taskId).not.toBe(started.teamRuns[0].steps[0].taskId);

    const completed = await waitFor(
      () => (hub as any).snapshot(),
      (snapshot: any) => snapshot.teamRuns[0]?.status === "completed",
    );

    expect(completed.teamRuns[0]).toMatchObject({
      status: "completed",
      steps: [
        expect.objectContaining({ roleName: "Security", status: "completed", artifact: expect.stringMatching(/^artifact-\d+$/) }),
        expect.objectContaining({ roleName: "Testing", status: "completed", artifact: expect.stringMatching(/^artifact-\d+$/) }),
      ],
    });
  });

  test("runs a supervisor team as lead plan, parallel workers, then lead synthesis", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-team-supervisor-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });

    const created = (hub as any).createTeam({
      name: "Supervisor Review",
      mode: "supervisor",
      sharedContext: "Shared supervisor context",
      members: [
        {
          roleName: "Lead",
          prompt: "Plan the work and coordinate outputs.",
          configuredAgentId: "default-agent",
        },
        {
          roleName: "Reviewer",
          prompt: "Review correctness.",
          configuredAgentId: "default-agent",
        },
        {
          roleName: "Verifier",
          prompt: "Verify test coverage.",
          configuredAgentId: "default-agent",
        },
      ],
    });
    const teamId = created.teams[0].id;

    const started = await (hub as any).runTeam({
      teamId,
      prompt: "Ship the workflow builder safely",
      workDir: dir,
    });

    expect(started.teamRuns[0]).toMatchObject({
      mode: "supervisor",
      status: "running",
      steps: [
        expect.objectContaining({ roleName: "Lead", status: "running" }),
        expect.objectContaining({ roleName: "Reviewer", status: "queued" }),
        expect.objectContaining({ roleName: "Verifier", status: "queued" }),
        expect.objectContaining({ roleName: "Lead Synthesis", status: "queued" }),
      ],
    });

    const workersRunning = await waitFor(
      () => (hub as any).snapshot(),
      (snapshot: any) =>
        snapshot.teamRuns[0]?.steps[0]?.status === "completed" &&
        snapshot.teamRuns[0]?.steps[1]?.status === "running" &&
        snapshot.teamRuns[0]?.steps[2]?.status === "running" &&
        snapshot.teamRuns[0]?.steps[3]?.status === "queued",
    );
    expect(workersRunning.teamRuns[0].steps[1].taskId).not.toBe(workersRunning.teamRuns[0].steps[2].taskId);
    const workerTask = workersRunning.tasks.find((task: any) => task.id === workersRunning.teamRuns[0].steps[1].taskId);
    expect(workerTask?.prompt).toContain("Lead");
    expect(workerTask?.prompt).toContain("artifact-1");

    const synthesisRunning = await waitFor(
      () => (hub as any).snapshot(),
      (snapshot: any) => snapshot.teamRuns[0]?.steps[3]?.status === "running",
    );
    const synthesisTask = synthesisRunning.tasks.find((task: any) => task.id === synthesisRunning.teamRuns[0].steps[3].taskId);
    expect(synthesisTask?.prompt).toContain("Reviewer");
    expect(synthesisTask?.prompt).toContain("Verifier");

    const completed = await waitFor(
      () => (hub as any).snapshot(),
      (snapshot: any) => snapshot.teamRuns[0]?.status === "completed",
    );
    expect(completed.teamRuns[0]).toMatchObject({
      status: "completed",
      steps: [
        expect.objectContaining({ roleName: "Lead", status: "completed", artifact: "artifact-1" }),
        expect.objectContaining({ roleName: "Reviewer", status: "completed", artifact: expect.stringMatching(/^artifact-\d+$/) }),
        expect.objectContaining({ roleName: "Verifier", status: "completed", artifact: expect.stringMatching(/^artifact-\d+$/) }),
        expect.objectContaining({ roleName: "Lead Synthesis", status: "completed", artifact: expect.stringMatching(/^artifact-\d+$/) }),
      ],
    });
  });

  test("runs a pipeline team in member order and passes artifacts to the next member", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-team-run-"));
    const fake = await writeSequentialCodexFake(dir);
    const hub = new AgentHub({ codex: fake.executable, claude: "missing-claude-for-test" });
    (hub as any).runtimes.set("codex", {
      id: "codex",
      label: "Codex",
      command: fake.executable,
      version: "test",
      available: true,
    });

    const created = (hub as any).createTeam({
      name: "Sequential Review",
      sharedContext: "Shared repo context",
      members: [
        {
          roleName: "Planner",
          prompt: "Create a short review plan before touching code.",
          configuredAgentId: "default-agent",
        },
        {
          roleName: "Checker",
          prompt: "Use prior artifacts, then verify risks and missing tests.",
          configuredAgentId: "default-agent",
        },
      ],
    });
    const teamId = created.teams[0].id;

    const started = await (hub as any).runTeam({
      teamId,
      prompt: "Review cd ../example-service",
      workDir: dir,
    });

    expect(started.teamRuns[0]).toMatchObject({
      teamId,
      teamName: "Sequential Review",
      status: "running",
      currentStepIndex: 0,
      sharedContextSnapshot: "Shared repo context",
      steps: [
        expect.objectContaining({ roleName: "Planner", status: "running" }),
        expect.objectContaining({ roleName: "Checker", status: "queued" }),
      ],
    });
    expect(started.teamRuns[0].workflow).toMatchObject({
      mode: "pipeline",
      nodes: [
        expect.objectContaining({ id: "start", status: "completed" }),
        expect.objectContaining({
          id: `member:${created.teams[0].members[0].id}`,
          kind: "agent",
          label: "Planner",
          stepId: started.teamRuns[0].steps[0].id,
          status: "running",
        }),
        expect.objectContaining({
          id: `member:${created.teams[0].members[1].id}`,
          kind: "agent",
          label: "Checker",
          stepId: started.teamRuns[0].steps[1].id,
          status: "queued",
        }),
        expect.objectContaining({ id: "done", status: "queued" }),
      ],
    });

    const firstTaskId = started.teamRuns[0].steps[0].taskId;
    const firstTask = started.tasks.find((task: any) => task.id === firstTaskId);
    expect(firstTask?.prompt).toContain("Review cd ../example-service");
    expect(firstTask?.prompt).toContain("Shared repo context");
    expect(firstTask?.prompt).toContain("Create a short review plan before touching code.");
    expect(firstTask?.runtimeConversation).toBeUndefined();
    expect(firstTask?.prompt).not.toContain("artifact-1");

    const afterFirst = await waitFor(
      () => (hub as any).snapshot(),
      (snapshot: any) => snapshot.teamRuns[0]?.steps[1]?.status === "running",
    );
    expect(afterFirst.teamRuns[0]).toMatchObject({
      status: "running",
      currentStepIndex: 1,
      steps: [
        expect.objectContaining({ roleName: "Planner", status: "completed", artifact: "artifact-1" }),
        expect.objectContaining({ roleName: "Checker", status: "running" }),
      ],
    });
    expect(afterFirst.teamRuns[0].workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `member:${created.teams[0].members[0].id}`, status: "completed" }),
        expect.objectContaining({ id: `member:${created.teams[0].members[1].id}`, status: "running" }),
        expect.objectContaining({ id: "done", status: "queued" }),
      ]),
    );

    const secondTaskId = afterFirst.teamRuns[0].steps[1].taskId;
    const secondTask = afterFirst.tasks.find((task: any) => task.id === secondTaskId);
    expect(secondTask?.prompt).toContain("Previous Agent Artifacts");
    expect(secondTask?.prompt).toContain("Planner");
    expect(secondTask?.prompt).toContain("artifact-1");
    expect(secondTask?.prompt).toContain("Use prior artifacts, then verify risks and missing tests.");
    expect(secondTask?.runtimeConversation).toBeUndefined();
    expect(secondTask?.id).not.toBe(firstTaskId);

    const completed = await waitFor(
      () => (hub as any).snapshot(),
      (snapshot: any) => snapshot.teamRuns[0]?.status === "completed",
    );
    expect(completed.teamRuns[0]).toMatchObject({
      status: "completed",
      steps: [
        expect.objectContaining({ roleName: "Planner", status: "completed", artifact: "artifact-1" }),
        expect.objectContaining({ roleName: "Checker", status: "completed", artifact: "artifact-2" }),
      ],
    });
    expect(completed.teamRuns[0].workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `member:${created.teams[0].members[0].id}`, status: "completed" }),
        expect.objectContaining({ id: `member:${created.teams[0].members[1].id}`, status: "completed" }),
        expect.objectContaining({ id: "done", status: "completed" }),
      ]),
    );
  });
});
