import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AgentEvent, RuntimeConversation } from "../../../../../shared/types";
import { openCodeRuntimeStateCodec } from "../../../../agents/opencode/opencode-runtime-state-codec";
import { writeNodeCliLauncher } from "../../../../platform/test-cli-fixtures";
import { createOpenCodeDriver } from "./create-opencode-driver";
import { AcpWorkflowOneShotExecutor } from "../acp-workflow-one-shot-executor";

async function createOpenCodeAcpFake(dir: string): Promise<{ executable: string; callsPath: string }> {
  const callsPath = path.join(dir, "calls.jsonl");
  const executable = await writeNodeCliLauncher(
    dir,
    "opencode-acp-fake",
    `const fs = require("node:fs");
const readline = require("node:readline");
const callsPath = ${JSON.stringify(callsPath)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(callsPath, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "ses_opencode_1" } });
  } else if (message.method === "session/resume" || message.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OpenCode interactive" } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`,
  );
  return { executable, callsPath };
}

describe("createOpenCodeDriver interactive integration", () => {
  test("uses ACP for one-shot workflow nodes so scoped MCP tools are available", () => {
    const driver = createOpenCodeDriver({
      executables: { codex: "codex", claude: "claude", api: "api", hermes: "hermes", opencode: "opencode", openclaw: "openclaw" },
      channelById: () => undefined,
      workflowMcpDiscoveryPath: () => "C:/app/mcp-bridge.json",
      workflowMcpManagedToken: () => "managed-token",
    });
    const executor = driver.createOneShotExecutor?.({
      runId: "task-1", runKind: "task", configuredAgentId: "agent-1", planningWorkflowId: "wf-1",
      workflowRunId: "run-1", workflowNodeId: "node-1", runtimeId: "opencode", executionMode: "oneshot",
      continuationPolicy: "fresh", runtimeConfig: { model: "default" },
      runtime: { id: "opencode", label: "OpenCode", command: "opencode", version: "test", available: true },
      channelId: "opencode-default", prompt: "Complete", workDir: process.cwd(), developerInstructions: "Complete structurally",
      emit: vi.fn(), onExit: vi.fn(),
    });

    expect(executor).toBeInstanceOf(AcpWorkflowOneShotExecutor);
  });

  test("starts OpenCode ACP, selects a model, and resumes persisted sessions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-opencode-driver-"));
    const fake = await createOpenCodeAcpFake(dir);
    const driver = createOpenCodeDriver({
      executables: { codex: "codex", claude: "claude", api: "api", hermes: "hermes", opencode: fake.executable, openclaw: "openclaw" },
      channelById: () => ({
        id: "opencode-default",
        agentId: "opencode",
        label: "OpenCode Default",
        models: [{ id: "openai/gpt-5", label: "GPT-5" }],
      }),
    });
    const events: AgentEvent[] = [];
    const createContext = (runtimeConversation: RuntimeConversation | undefined = undefined) => ({
      chatId: "chat-1",
      configuredAgentId: "opencode-agent",
      runtimeId: "opencode" as const,
      executionMode: "interactive" as const,
      continuationPolicy: "resume-preferred" as const,
      runtimeConfig: { model: "openai/gpt-5" },
      ...(runtimeConversation ? { runtimeConversation } : {}),
      runtime: { id: "opencode" as const, label: "OpenCode", command: fake.executable, version: "test", available: true },
      channelId: "opencode-default",
      workDir: dir,
      developerInstructions: "Desktop instructions",
      emit: (event: AgentEvent) => events.push(event),
      syncState: vi.fn(),
    });

    const first = driver.createInteractiveSession?.(createContext());
    if (!first) throw new Error("OpenCode interactive session hook is missing.");
    await first.ensureAttached();
    await first.sendPrompt("hello");
    const runtimeConversation = first.snapshot().runtimeConversation;
    await first.detach("idle_timeout");

    expect(openCodeRuntimeStateCodec.decodeConversation(runtimeConversation)?.native.sessionId).toBe("ses_opencode_1");
    expect(events).toEqual(expect.arrayContaining([
      { type: "delta", content: "OpenCode interactive" },
      { type: "completed" },
    ]));

    const second = driver.createInteractiveSession?.(createContext(runtimeConversation));
    if (!second) throw new Error("OpenCode interactive session hook is missing.");
    await second.ensureAttached();
    await second.sendPrompt("continue");
    await second.detach("app_shutdown");

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    expect(calls.filter((call) => call.method === "session/new")).toHaveLength(1);
    expect(calls.some((call) => call.method === "session/resume" && call.params.sessionId === "ses_opencode_1")).toBe(true);
    expect(calls.some((call) => call.method === "session/set_model" && call.params.modelId === "openai/gpt-5")).toBe(true);
  }, 15_000);
});
