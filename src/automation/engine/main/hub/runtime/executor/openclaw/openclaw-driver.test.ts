import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AgentEvent, RuntimeConversation } from "../../../../../shared/types";
import { openClawRuntimeStateCodec } from "../../../../agents/openclaw/openclaw-runtime-state-codec";
import { writeNodeCliLauncher } from "../../../../platform/test-cli-fixtures";
import { createOpenClawDriver } from "./create-openclaw-driver";

async function createOpenClawAcpFake(dir: string): Promise<{ executable: string; callsPath: string }> {
  const callsPath = path.join(dir, "calls.jsonl");
  const executable = await writeNodeCliLauncher(
    dir,
    "runtime-acp-fake",
    `const fs = require("node:fs");
const readline = require("node:readline");
const callsPath = ${JSON.stringify(callsPath)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(callsPath, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agent:main:acp-bridge:desktop" } });
  } else if (message.method === "session/resume") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OpenClaw interactive" } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`,
  );
  return { executable, callsPath };
}

describe("createOpenClawDriver interactive integration", () => {
  test("starts the OpenClaw ACP bridge and resumes its Gateway session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-driver-"));
    const fake = await createOpenClawAcpFake(dir);
    const driver = createOpenClawDriver({
      executables: {
        codex: "codex",
        claude: "claude",
        api: "api",
        hermes: "hermes",
        opencode: "opencode",
        openclaw: fake.executable,
      },
      channelById: () => ({
        id: "openclaw-default",
        agentId: "openclaw",
        label: "OpenClaw Default",
        models: [{ id: "openai/gpt-5.4", label: "GPT-5.4" }],
      }),
    });
    const events: AgentEvent[] = [];
    const createContext = (runtimeConversation: RuntimeConversation | undefined = undefined) => ({
      chatId: "chat-1",
      configuredAgentId: "openclaw-agent",
      runtimeId: "openclaw" as const,
      executionMode: "interactive" as const,
      continuationPolicy: "resume-preferred" as const,
      runtimeConfig: { model: "openai/gpt-5.4" },
      ...(runtimeConversation ? { runtimeConversation } : {}),
      runtime: { id: "openclaw" as const, label: "OpenClaw", command: fake.executable, version: "test", available: true },
      channelId: "openclaw-default",
      workDir: dir,
      developerInstructions: "Desktop instructions",
      emit: (event: AgentEvent) => events.push(event),
      syncState: vi.fn(),
    });

    const first = driver.createInteractiveSession?.(createContext());
    if (!first) throw new Error("OpenClaw interactive session hook is missing.");
    await first.ensureAttached();
    await first.sendPrompt("hello");
    const runtimeConversation = first.snapshot().runtimeConversation;
    await first.detach("idle_timeout");
    expect(openClawRuntimeStateCodec.decodeConversation(runtimeConversation)?.native.sessionId).toBe("agent:main:acp-bridge:desktop");
    expect(events).toEqual(expect.arrayContaining([
      { type: "delta", content: "OpenClaw interactive" },
      { type: "completed" },
    ]));

    const second = driver.createInteractiveSession?.(createContext(runtimeConversation));
    if (!second) throw new Error("OpenClaw interactive session hook is missing.");
    await second.ensureAttached();
    await second.sendPrompt("continue");
    await second.detach("app_shutdown");

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    expect(calls.filter((call) => call.method === "session/new")).toHaveLength(1);
    expect(calls.some((call) => call.method === "session/resume" && call.params.sessionId === "agent:main:acp-bridge:desktop")).toBe(true);
    expect(calls.some((call) => call.method === "session/set_model")).toBe(false);
  }, 15_000);
});
