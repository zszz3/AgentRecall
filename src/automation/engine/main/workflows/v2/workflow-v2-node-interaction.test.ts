import { describe, expect, test } from "vitest";
import type { WorkflowV2HumanIntervention } from "../../../shared/workflow-v2/review";
import { projectWorkflowV2PausedNodeInteraction } from "./workflow-v2-node-interaction";

const intervention: WorkflowV2HumanIntervention = {
  nodeId: "research",
  source: "supervision_pause" as const,
  reason: "Interactive node is waiting for user confirmation.",
  allowedActions: ["continue"],
  requestedAt: 1,
  progressReport: {
    nodeId: "research",
    attempt: 1,
    phase: "interactive",
    completedItems: [],
    remainingItems: ["User confirmation"],
    blockers: [],
    evidence: [],
    safeToInterrupt: true,
    requestedAction: "need_input",
    reportedAt: 1,
  },
};

describe("projectWorkflowV2PausedNodeInteraction", () => {
  test("projects interactive agent input as awaiting input instead of a generic pause", () => {
    expect(projectWorkflowV2PausedNodeInteraction({ nodeId: "research", interactiveAgent: true, intervention })).toMatchObject({
      progress: { status: "awaiting_input", inputRequest: { kind: "agent_message" } },
      event: { type: "gate_opened" },
    });
  });

  test("projects typed script parameters through the same input request contract", () => {
    expect(projectWorkflowV2PausedNodeInteraction({
      nodeId: "transform",
      interactiveAgent: false,
      intervention: { ...intervention, nodeId: "transform" },
      control: {
        extensionCount: 0,
        scriptInput: {
          requestedParameters: [{ key: "body", label: "Body", location: "body", valueType: "json", source: "user", required: true }],
          submittedValues: {},
          auditValues: {},
          requestedAt: 1,
        },
      },
    })).toMatchObject({
      progress: { status: "awaiting_input", inputRequest: { kind: "script_parameters", parameters: [{ key: "body" }] } },
      event: { type: "gate_opened" },
    });
  });

  test("keeps permission decisions as control interventions instead of text input", () => {
    expect(projectWorkflowV2PausedNodeInteraction({ nodeId: "command", interactiveAgent: false, intervention })).toMatchObject({
      progress: { status: "paused", intervention: { nodeId: "research" } },
      event: { type: "node_paused" },
    });
  });
});
