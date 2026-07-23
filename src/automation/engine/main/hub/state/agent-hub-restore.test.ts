import { describe, expect, test } from "vitest";
import { restoreWorkflowEvent, restoreWorkflowRunProgressItem } from "./agent-hub-restore";

function intervention() {
  return {
    nodeId: "implement",
    source: "supervision_pause" as const,
    reason: "Needs user input.",
    allowedActions: ["continue" as const, "skip" as const],
    requestedAt: 1_000,
    progressReport: {
      nodeId: "implement",
      attempt: 1,
      phase: "blocked",
      completedItems: ["checkpoint captured"],
      remainingItems: ["finish"],
      blockers: ["needs input"],
      evidence: ["checkpoint-1"],
      checkpoint: "checkpoint-1",
      safeToInterrupt: true,
      requestedAction: "need_input" as const,
      reportedAt: 900,
    },
    supervisorDecision: {
      action: "pause" as const,
      question: "Provide input?",
      reason: "Input is required.",
    },
  };
}

describe("agent hub workflow event restore", () => {
  test("restores and clones a valid Workflow V2 intervention payload", () => {
    const rawIntervention = intervention();
    const event = restoreWorkflowEvent({
      type: "node_paused",
      nodeId: "implement",
      at: 1_100,
      intervention: rawIntervention,
    });

    expect(event?.intervention).toEqual(rawIntervention);
    expect(event?.intervention).not.toBe(rawIntervention);
    expect(event?.intervention?.progressReport).not.toBe(rawIntervention.progressReport);
  });

  test("drops an invalid intervention payload without dropping the event", () => {
    const event = restoreWorkflowEvent({
      type: "node_paused",
      nodeId: "implement",
      at: 1_100,
      intervention: { ...intervention(), allowedActions: ["execute-shell"] },
    });

    expect(event).toMatchObject({ type: "node_paused", nodeId: "implement" });
    expect(event?.intervention).toBeUndefined();
  });
});

describe("agent hub workflow progress restore", () => {
  test("preserves typed script input requests for waiting nodes", () => {
    const rawParameter = {
      key: "text",
      label: "输入内容",
      location: "stdin",
      valueType: "string",
      source: "user",
      required: true,
    };

    const progress = restoreWorkflowRunProgressItem({
      nodeId: "echo",
      title: "原样输出用户输入",
      status: "awaiting_input",
      detail: "Waiting for 输入内容",
      inputRequest: { kind: "script_parameters", parameters: [rawParameter] },
      outputs: { preview: "restored" },
      messages: [{ id: "message-1", role: "assistant", content: "Persisted answer", at: 1_200 }],
    });

    expect(progress?.inputRequest).toEqual({ kind: "script_parameters", parameters: [rawParameter] });
    expect(progress?.inputRequest?.kind === "script_parameters" ? progress.inputRequest.parameters[0] : undefined).not.toBe(rawParameter);
    expect(progress?.outputs).toEqual({ preview: "restored" });
    expect(progress?.messages).toEqual([{ id: "message-1", role: "assistant", content: "Persisted answer", at: 1_200 }]);
  });

  test("drops malformed input requests without dropping node progress", () => {
    const progress = restoreWorkflowRunProgressItem({
      nodeId: "echo",
      title: "Echo",
      status: "awaiting_input",
      inputRequest: {
        kind: "script_parameters",
        parameters: [{ key: "text", label: "Text", location: "invalid", valueType: "string", source: "user", required: true }],
      },
    });

    expect(progress).toMatchObject({ nodeId: "echo", status: "awaiting_input" });
    expect(progress?.inputRequest).toBeUndefined();
  });

  test("restores node execution telemetry without requiring usage fields", () => {
    const progress = restoreWorkflowRunProgressItem({
      nodeId: "research",
      title: "Research",
      status: "completed",
      telemetry: {
        runtimeId: "codex",
        channelId: "codex-openai",
        modelId: "gpt-5.5",
        attempt: 2,
        startedAt: 10_000,
        finishedAt: 25_000,
        totalTokens: 1_540,
        estimatedCost: 0.031,
      },
    });

    expect(progress?.telemetry).toEqual({
      runtimeId: "codex",
      channelId: "codex-openai",
      modelId: "gpt-5.5",
      attempt: 2,
      startedAt: 10_000,
      finishedAt: 25_000,
      totalTokens: 1_540,
      estimatedCost: 0.031,
    });
  });
});
