import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { WorkflowRunState } from "../../../../shared/types";
import { WorkflowRunCenter } from "./WorkflowRunCenter";

function run(input: { runId: string; status: WorkflowRunState["status"]; startedAt: number; finishedAt?: number; lastError?: string }): WorkflowRunState {
  const plan = {
    workflowId: "workflow",
    objective: "Prepare a report",
    graphVersion: input.runId === "latest" ? 4 : 3,
    definition: { workflowId: "workflow", graphVersion: 1, objective: "Prepare a report", nodes: [], edges: [] },
    approvedBy: "desktop-user",
    frozenAt: input.startedAt,
    acceptanceCriteria: [],
    roleDefaults: {},
    nodes: [{ nodeId: "research", title: "Research", role: "executor", execModel: "llm", executionMode: "one-shot", modelProfile: "fast", modelId: "gpt-test" }],
    budget: { context: { maxContextTokens: 4000 } },
  } as unknown as WorkflowRunState["workflowV2Plan"];
  return {
    runId: input.runId,
    workflowId: "workflow",
    status: input.status,
    workflowV2Plan: plan,
    progress: [{
      nodeId: "research",
      title: "Research",
      status: input.status === "failed" ? "failed" : "completed",
      detail: input.status === "failed" ? "Provider disconnected" : "Report ready",
      messages: [{ id: `${input.runId}:assistant`, role: "assistant", content: "Historical research answer", at: input.startedAt + 1_500 }],
    }],
    events: [
      { type: "node_started", nodeId: "research", at: input.startedAt + 1_000, attempt: 1 },
      input.status === "failed"
        ? { type: "node_failed", nodeId: "research", at: (input.finishedAt ?? input.startedAt) + 2_000, attempt: 1, error: "Provider disconnected" }
        : { type: "node_completed", nodeId: "research", at: input.finishedAt ?? input.startedAt + 2_000, attempt: 1 },
    ],
    contextDocument: "",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    lastError: input.lastError,
  };
}

describe("WorkflowRunCenter", () => {
  test("does not render while closed", () => {
    expect(renderToStaticMarkup(<WorkflowRunCenter runs={[]} open={false} onSelectRun={() => undefined} onClose={() => undefined} />)).toBe("");
  });

  test("renders the selected historical run with frozen configuration, timeline, and errors", () => {
    const html = renderToStaticMarkup(<WorkflowRunCenter
      runs={[
        run({ runId: "latest", status: "completed", startedAt: 2_000, finishedAt: 62_000 }),
        run({ runId: "failed-run", status: "failed", startedAt: 1_000, finishedAt: 31_000, lastError: "Provider disconnected" }),
      ]}
      open
      selectedRunId="failed-run"
      onSelectRun={() => undefined}
      onClose={() => undefined}
    />);

    expect(html).toContain("Run history");
    expect(html).toContain("2 runs");
    expect(html).toContain("failed-run");
    expect(html).toContain("Frozen configuration");
    expect(html).toContain("desktop-user");
    expect(html).toContain("Graph version");
    expect(html).toContain("v3");
    expect(html).toContain("Research");
    expect(html).toContain("llm · gpt-test");
    expect(html).toContain("node failed");
    expect(html).toContain("Provider disconnected");
    expect(html).toContain("Message history");
    expect(html).toContain("Historical research answer");
  });

  test("renders node execution telemetry for runtime, channel, model, attempts, tokens, cost, and duration", () => {
    const observedRun = run({ runId: "observed-run", status: "completed", startedAt: 2_000, finishedAt: 62_000 });
    (observedRun.progress[0] as WorkflowRunState["progress"][number] & { telemetry: unknown }).telemetry = {
      provider: "anthropic",
      runtimeId: "codex",
      channelId: "codex-openai",
      modelId: "gpt-5.5",
      attempt: 2,
      startedAt: 10_000,
      finishedAt: 25_000,
      inputTokens: 1_200,
      outputTokens: 340,
      reasoningTokens: 120,
      cacheReadInputTokens: 80,
      cacheWrite5mInputTokens: 40,
      cacheWrite1hInputTokens: 20,
      totalTokens: 1_540,
      estimatedCost: 0.031,
    };

    const html = renderToStaticMarkup(<WorkflowRunCenter
      runs={[observedRun]}
      open
      selectedRunId="observed-run"
      onSelectRun={() => undefined}
      onClose={() => undefined}
    />);

    expect(html).toContain("Runtime");
    expect(html).toContain("codex");
    expect(html).toContain("Channel");
    expect(html).toContain("codex-openai");
    expect(html).toContain("Attempts");
    expect(html).toContain("2");
    expect(html).toContain("Token usage");
    expect(html).toContain("Input tokens");
    expect(html).toContain("1,200");
    expect(html).toContain("Reasoning tokens");
    expect(html).toContain("120");
    expect(html).toContain("Cache read");
    expect(html).toContain("80");
    expect(html).toContain("Cache write · 5 min");
    expect(html).toContain("40");
    expect(html).toContain("Cache write · 1 hour");
    expect(html).toContain("20");
    expect(html).toContain("1,540");
    expect(html).toContain("$0.031");
    expect(html).toContain("15s");
  });

  test("uses OpenAI cached-input semantics separately from Anthropic cache fields", () => {
    const observedRun = run({ runId: "openai-run", status: "completed", startedAt: 2_000, finishedAt: 62_000 });
    (observedRun.progress[0] as WorkflowRunState["progress"][number] & { telemetry: unknown }).telemetry = {
      provider: "openai",
      attempt: 1,
      startedAt: 10_000,
      finishedAt: 20_000,
      inputTokens: 1_000,
      cacheReadInputTokens: 400,
      outputTokens: 200,
      totalTokens: 1_200,
    };

    const html = renderToStaticMarkup(<WorkflowRunCenter
      runs={[observedRun]}
      open
      selectedRunId="openai-run"
      onSelectRun={() => undefined}
      onClose={() => undefined}
    />);

    expect(html).toContain("Cached input (OpenAI)");
    expect(html).toContain("400");
    expect(html).toContain("Cache read (Anthropic)</b>—");
    expect(html).toContain("Cache write · 5 min</b>—");
  });

  test("shows persisted interactive conversation messages for the selected run node", () => {
    const html = renderToStaticMarkup(<WorkflowRunCenter
      runs={[run({ runId: "interactive-run", status: "completed", startedAt: 2_000, finishedAt: 62_000 })]}
      conversations={[{
        conversationId: "conversation-1",
        workflowId: "workflow",
        runId: "interactive-run",
        nodeId: "research",
        configuredAgentId: "agent",
        modelId: "model",
        workDir: "C:/workspace",
        status: "closed",
        messages: [{ id: "message-1", role: "user", content: "Persist this follow-up", at: 3_000 }],
        createdAt: 2_000,
        updatedAt: 3_000,
        lastActivityAt: 3_000,
      }]}
      open
      selectedRunId="interactive-run"
      onSelectRun={() => undefined}
      onClose={() => undefined}
    />);

    expect(html).toContain("Persist this follow-up");
    expect(html).not.toContain("Historical research answer");
  });

  test("distinguishes archived tool calls from their results", () => {
    const archivedRun = run({ runId: "tool-run", status: "completed", startedAt: 2_000, finishedAt: 62_000 });
    archivedRun.progress[0].messages = [
      { id: "tool-call", role: "tool", eventType: "tool_call", name: "read_file", content: '{"path":"README.md"}', at: 3_000 },
      { id: "tool-result", role: "tool", eventType: "tool_result", name: "read_file", content: "README contents", at: 4_000 },
    ];
    const html = renderToStaticMarkup(<WorkflowRunCenter
      runs={[archivedRun]}
      open
      selectedRunId="tool-run"
      language="zh"
      onSelectRun={() => undefined}
      onClose={() => undefined}
    />);

    expect(html).toContain("工具调用 · read_file");
    expect(html).toContain("工具结果 · read_file");
    expect(html).toContain("{&quot;path&quot;:&quot;README.md&quot;}");
    expect(html).toContain("README contents");
  });

  test("opens as a history list before a run is selected", () => {
    const html = renderToStaticMarkup(<WorkflowRunCenter
      runs={[run({ runId: "latest", status: "completed", startedAt: 2_000, finishedAt: 62_000 })]}
      open
      onSelectRun={() => undefined}
      onClose={() => undefined}
    />);

    expect(html).toContain("workflow-run-center-backdrop");
    expect(html).toContain("Select a run to view its details");
    expect(html).not.toContain("Frozen configuration");
  });
});
