import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../../../shared/types";
import { writeNodeCliLauncher } from "../../platform/test-cli-fixtures";
import { AcpInteractiveClient, agentEventsFromAcpUpdate, fileWriteOperationFromAcpUpdate, workflowMcpDecisionFromAcpToolCall } from "./acp-interactive-client";
import { RuntimeApprovalBroker } from "../../approvals/runtime-approval-broker";

async function createFakeAcpRuntime(dir: string, toolTitle = "Read file"): Promise<{ executable: string; callsPath: string }> {
  const callsPath = path.join(dir, "calls.jsonl");
  const executable = await writeNodeCliLauncher(
    dir,
    "fake-acp-runtime",
    `const fs = require("node:fs");
const readline = require("node:readline");
const callsPath = ${JSON.stringify(callsPath)};
const toolTitle = ${JSON.stringify(toolTitle)};
let promptRequestId;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  fs.appendFileSync(callsPath, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "acp-session-1" } });
  } else if (message.method === "session/resume" || message.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    promptRequestId = message.id;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: toolTitle, kind: "read", status: "in_progress", rawInput: { path: "README.md" } } } });
    send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { sessionId: message.params.sessionId, toolCall: { toolCallId: "tool-1", title: toolTitle }, options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
  } else if (message.id === 900 && message.result) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-session-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Read file", status: "completed", rawOutput: "contents" } } });
    send({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } });
  }
});
`,
  );
  return { executable, callsPath };
}

describe("AcpInteractiveClient", () => {
  test("creates an ACP session, streams updates, approves once, and cancels", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-acp-client-"));
    const fake = await createFakeAcpRuntime(dir);
    const events: AgentEvent[] = [];
    const broker = new RuntimeApprovalBroker();
    const client = new AcpInteractiveClient({
      executable: fake.executable,
      args: ["acp"],
      cwd: dir,
      modelId: "custom-model",
      mcpServers: [{ name: "Filesystem", command: "node", args: ["server.js"], env: [] }],
      onEvent: (event) => events.push(event),
      approvalOwnerId: "chat-1",
      requestApproval: async (request) => {
        const pending = broker.request(request);
        queueMicrotask(() => {
          const approval = events.find((event) => event.type === "approval_request");
          if (approval?.type === "approval_request") {
            broker.resolve({ ownerId: "chat-1", requestId: approval.requestId, decision: "approved" });
          }
        });
        return pending;
      },
    });

    await expect(client.attach()).resolves.toBe("acp-session-1");
    await client.prompt("hello");
    await client.interrupt();
    await client.detach();

    expect(events).toEqual(expect.arrayContaining([
      { type: "delta", content: "Hello" },
      expect.objectContaining({ type: "tool_call", name: "Read file" }),
      expect.objectContaining({ type: "approval_request", requestId: expect.stringMatching(/^runtime-approval:/) }),
      expect.objectContaining({ type: "approval_response", decision: "approved" }),
      expect.objectContaining({ type: "tool_result", name: "Read file", content: "contents" }),
      { type: "completed" },
    ]));
    const calls = (await readFile(fake.callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(calls.some((call) => call.method === "session/new")).toBe(true);
    expect(calls.find((call) => call.method === "session/new")?.params.mcpServers).toEqual([
      { name: "Filesystem", command: "node", args: ["server.js"], env: [] },
    ]);
    expect(calls.some((call) => call.method === "session/set_model" && call.params.modelId === "custom-model")).toBe(true);
    expect(calls.some((call) => call.method === "session/prompt" && call.params.prompt[0].text === "hello")).toBe(true);
    expect(calls.some((call) => call.method === "session/cancel")).toBe(true);
    expect(calls.find((call) => call.id === 900)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  }, 15_000);

  test("resumes an existing ACP session without creating a new one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-acp-resume-"));
    const fake = await createFakeAcpRuntime(dir);
    const client = new AcpInteractiveClient({
      executable: fake.executable,
      args: ["acp"],
      cwd: dir,
      onEvent: vi.fn(),
    });

    await expect(client.attach("existing-session")).resolves.toBe("existing-session");
    await client.detach();

    const calls = (await readFile(fake.callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(calls.some((call) => call.method === "session/resume" && call.params.sessionId === "existing-session")).toBe(true);
    expect(calls.some((call) => call.method === "session/new")).toBe(false);
  }, 15_000);

  test("auto-allows planning MCP tools without cancelling workflow sessions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-acp-workflow-"));
    const fake = await createFakeAcpRuntime(dir, "workflow_update");
    const client = new AcpInteractiveClient({
      executable: fake.executable,
      args: ["acp"],
      cwd: dir,
      onEvent: vi.fn(),
      approvalOwnerId: "workflow-draft:wf-1",
      workflowMcpScope: "planning",
    });

    await client.attach();
    await client.prompt("update it");
    await client.detach();

    const calls = (await readFile(fake.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    expect(calls.find((call) => call.id === 900)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  }, 15_000);
});

describe("agentEventsFromAcpUpdate", () => {
  test("uses the shared workflow policy for ACP runtimes", () => {
    expect(workflowMcpDecisionFromAcpToolCall("workflow_update", "planning")).toBe("allow");
    expect(workflowMcpDecisionFromAcpToolCall("workflow_run", "planning")).toBe("approval_required");
    expect(workflowMcpDecisionFromAcpToolCall("workflow_node_complete", "node_execution")).toBe("allow");
    expect(workflowMcpDecisionFromAcpToolCall("Read file", "planning")).toBe("deny");
  });
  test("maps ACP thought and plan updates into visible metadata", () => {
    expect(agentEventsFromAcpUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
    })).toEqual([{ type: "meta", content: "thinking" }]);
  });

  test("normalizes ACP edit tool paths for output-write policy checks", () => {
    expect(fileWriteOperationFromAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      title: "Write report",
      kind: "edit",
      status: "pending",
      rawInput: { path: "outputs/wf/run/report.md" },
    }, "C:/repo")).toEqual({
      kind: "file_write",
      cwd: "C:/repo",
      paths: ["outputs/wf/run/report.md"],
    });
  });
});
