import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AgentEvent, RuntimeConversation } from "../../../../../shared/types";
import { writeNodeCliLauncher } from "../../../../platform/test-cli-fixtures";
import { hermesRuntimeStateCodec } from "../../../../agents/hermes/hermes-runtime-state-codec";
import { createHermesDriver } from "./create-hermes-driver";

async function createHermesAcpFake(dir: string): Promise<{ executable: string; callsPath: string }> {
  const callsPath = path.join(dir, "calls.jsonl");
  const executable = await writeNodeCliLauncher(
    dir,
    "hermes-acp-fake",
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-acp-session" } });
  } else if (message.method === "session/resume") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hermes interactive" } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`,
  );
  return { executable, callsPath };
}

describe("createHermesDriver interactive integration", () => {
  test("starts Hermes ACP, persists the session, and resumes it after detach", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-hermes-driver-"));
    const fake = await createHermesAcpFake(dir);
    const driver = createHermesDriver({
      executables: { codex: "codex", claude: "claude", api: "api", hermes: fake.executable, opencode: "opencode", openclaw: "openclaw" },
      channelById: () => ({
        id: "hermes-default",
        agentId: "hermes",
        label: "Hermes Default",
        models: [{ id: "default", label: "Default" }],
      }),
    });
    const events: AgentEvent[] = [];
    const createContext = (runtimeConversation: RuntimeConversation | undefined = undefined) => ({
      chatId: "chat-1",
      configuredAgentId: "hermes-agent",
      runtimeId: "hermes" as const,
      executionMode: "interactive" as const,
      continuationPolicy: "resume-preferred" as const,
      runtimeConfig: { model: "default" },
      ...(runtimeConversation ? { runtimeConversation } : {}),
      runtime: { id: "hermes" as const, label: "Hermes", command: fake.executable, version: "test", available: true },
      channelId: "hermes-default",
      workDir: dir,
      developerInstructions: "Desktop instructions",
      emit: (event: AgentEvent) => events.push(event),
      syncState: vi.fn(),
    });

    const first = driver.createInteractiveSession?.(createContext());
    if (!first) throw new Error("Hermes interactive session hook is missing.");
    await first.ensureAttached();
    await first.sendPrompt("hello");
    const runtimeConversation = first.snapshot().runtimeConversation;
    await first.detach("idle_timeout");

    expect(hermesRuntimeStateCodec.decodeConversation(runtimeConversation)?.native.sessionId).toBe("hermes-acp-session");
    expect(events).toEqual(expect.arrayContaining([
      { type: "delta", content: "Hermes interactive" },
      { type: "completed" },
    ]));

    const second = driver.createInteractiveSession?.(createContext(runtimeConversation));
    if (!second) throw new Error("Hermes interactive session hook is missing.");
    await second.ensureAttached();
    await second.sendPrompt("continue");
    await second.detach("app_shutdown");

    const calls = (await readFile(fake.callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(calls.filter((call) => call.method === "session/new")).toHaveLength(1);
    expect(calls.some((call) => call.method === "session/resume" && call.params.sessionId === "hermes-acp-session")).toBe(true);
  }, 15_000);
});
