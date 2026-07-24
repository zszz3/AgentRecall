import { describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../../../shared/types";
import { ClaudeAgentSdkAdapter, createClaudeSdkPermissionHandler, createClaudeSdkQueryOptions } from "./claude-agent-sdk";

describe("ClaudeAgentSdkAdapter", () => {
  test("passes an isolated provider environment to Claude Code", () => {
    const env = { PATH: "/bin", ANTHROPIC_AUTH_TOKEN: "test-key" };
    expect(
      createClaudeSdkQueryOptions({
        cwd: "/tmp/project",
        env,
        onEvent: () => undefined,
      }).env,
    ).toEqual(env);
  });

  test("runs Claude one-shot through the official SDK single-message path", async () => {
    const events: AgentEvent[] = [];
    const runOneShot = vi.fn(async function* (input: { prompt: string; options?: Record<string, unknown> }) {
      expect(input.prompt).toBe("hello");
      yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
      yield { type: "result", subtype: "success", result: "hello", session_id: "claude-session-1" };
    });

    const adapter = new ClaudeAgentSdkAdapter({ queryImpl: runOneShot as never });
    await adapter.runOneShot({
      prompt: "hello",
      cwd: "C:/repo",
      modelId: "claude-sonnet",
      developerInstructions: "Be precise.",
      onEvent: (event) => events.push(event),
    });

    expect(runOneShot).toHaveBeenCalledTimes(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "delta", content: "hello" }),
        expect.objectContaining({
          type: "runtime_conversation",
          runtimeConversation: expect.objectContaining({
            runtimeId: "claude",
            codecVersion: "v1",
            payload: { native: { sessionId: "claude-session-1" } },
          }),
        }),
        expect.objectContaining({ type: "completed" }),
      ]),
    );
  });

  test("passes Claude SDK query options for cwd, model, resume, mcp servers, and appended system instructions", async () => {
    const runOneShot = vi.fn(async function* (input: { prompt: string; options?: Record<string, unknown> }) {
      yield { type: "result", subtype: "success", result: "done", session_id: "claude-session-2" };
      expect(input).toMatchObject({
        prompt: "resume this",
        options: {
          cwd: "C:/repo",
          model: "claude-opus",
          resume: "claude-session-1",
          mcpServers: {
            multi_agent_chat: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: "Keep answers short.",
          },
        },
      });
    });

    const adapter = new ClaudeAgentSdkAdapter({ queryImpl: runOneShot as never });
    await adapter.runOneShot({
      prompt: "resume this",
      cwd: "C:/repo",
      modelId: "claude-opus",
      developerInstructions: "Keep answers short.",
      resumeSessionId: "claude-session-1",
      mcpServers: {
        multi_agent_chat: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
        },
      },
      onEvent: () => undefined,
    });

    expect(runOneShot).toHaveBeenCalledTimes(1);
  });
});

describe("createClaudeSdkPermissionHandler", () => {
  test("fails closed without an approval broker", async () => {
    const handler = createClaudeSdkPermissionHandler(vi.fn());
    await expect(handler("Bash", {}, { signal: new AbortController().signal, toolUseID: "tool-1" } as never))
      .resolves.toMatchObject({ behavior: "deny", toolUseID: "tool-1" });
  });

  test("allows only after the bound approval request is approved", async () => {
    const requestApproval = vi.fn(async () => "approved" as const);
    const handler = createClaudeSdkPermissionHandler(vi.fn(), "chat-1", requestApproval);
    await expect(handler("Write", { file_path: "a.txt" }, { signal: new AbortController().signal, toolUseID: "tool-2" } as never))
      .resolves.toEqual({ behavior: "allow", toolUseID: "tool-2" });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "chat-1", provider: "claude" }));
  });

  test("allows only trusted workflow authoring tools on non-interactive workflow surfaces", async () => {
    const requestApproval = vi.fn(async () => "approved" as const);
    const handler = createClaudeSdkPermissionHandler(vi.fn(), "workflow-draft:wf-1", requestApproval, undefined, undefined, "planning");
    await expect(handler("mcp__agent_recall__workflow_update", {}, { toolUseID: "tool-3" } as never))
      .resolves.toMatchObject({ behavior: "allow" });
    await expect(handler("Bash", {}, { toolUseID: "tool-4" } as never))
      .resolves.toMatchObject({ behavior: "deny" });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  test("allows node completion only on node execution surfaces", async () => {
    const planning = createClaudeSdkPermissionHandler(vi.fn(), "workflow-draft:wf-1", undefined, undefined, undefined, "planning");
    const node = createClaudeSdkPermissionHandler(vi.fn(), "workflow-run:run-1", undefined, undefined, undefined, "node_execution");
    await expect(planning("mcp__agent_recall__workflow_node_complete", {}, { toolUseID: "tool-6" } as never))
      .resolves.toMatchObject({ behavior: "deny" });
    await expect(node("mcp__agent_recall_workflow__workflow_node_complete", {}, { toolUseID: "tool-7" } as never))
      .resolves.toMatchObject({ behavior: "allow" });
  });

  test("describes Claude Write as a normalized file-write operation", async () => {
    const requestApproval = vi.fn(async () => "approved" as const);
    const handler = createClaudeSdkPermissionHandler(vi.fn(), "task-1", requestApproval, undefined, "C:/repo");
    await handler("Write", { file_path: "outputs/wf/run/report.md", content: "report" }, { toolUseID: "tool-5" } as never);
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      operation: { kind: "file_write", cwd: "C:/repo", paths: ["outputs/wf/run/report.md"] },
    }));
  });
});
