import { describe, expect, test } from "vitest";

import {
  cloneWorkflowV2WorkerOutput,
  type WorkflowV2WorkProposal,
  type WorkflowV2WorkerOutput,
} from "./packets";

type WorkflowV2ContinueProposalWithMetadata = Extract<
  WorkflowV2WorkProposal,
  { kind: "continue" }
> & { metadata: { traceIds: string[] } };

describe("workflow-v2 packets", () => {
  test("keeps structured outputs separate from control proposals", () => {
    const output: WorkflowV2WorkerOutput = {
      nodeId: "implement",
      summary: "Implementation finished",
      outputs: { diff: "src/app.ts" },
      evidence: ["tests passed"],
      risks: ["needs reviewer confirmation"],
      proposals: [{ kind: "escalate", reason: "touches shared runtime" }],
    };

    const cloned = cloneWorkflowV2WorkerOutput(output);

    expect(cloned.outputs).toEqual({ diff: "src/app.ts" });
    expect(cloned.proposals).toEqual([{ kind: "escalate", reason: "touches shared runtime" }]);
    expect(cloned.outputs).not.toBe(output.outputs);
    expect(cloned.proposals).not.toBe(output.proposals);
  });

  test("deep-clones nested mutable proposal fields", () => {
    const output: WorkflowV2WorkerOutput = {
      nodeId: "review",
      summary: "Review requires follow-up routing",
      outputs: { verdict: "retry" },
      proposals: [
        {
          kind: "continue",
          reason: "Route work to the fix-up nodes",
          targetNodeIds: ["implement", "docs"],
          metadata: {
            traceIds: ["trace-1"],
          },
        } as WorkflowV2ContinueProposalWithMetadata,
      ],
    };

    const cloned = cloneWorkflowV2WorkerOutput(output);
    const originalProposal = output.proposals[0] as WorkflowV2ContinueProposalWithMetadata;
    const clonedProposal = cloned.proposals[0] as WorkflowV2ContinueProposalWithMetadata;

    expect(clonedProposal.targetNodeIds).toEqual(["implement", "docs"]);
    expect(clonedProposal.targetNodeIds).not.toBe(originalProposal.targetNodeIds);
    expect(clonedProposal.metadata).toEqual({ traceIds: ["trace-1"] });
    expect(clonedProposal.metadata).not.toBe(originalProposal.metadata);
    expect(clonedProposal.metadata.traceIds).not.toBe(originalProposal.metadata.traceIds);
  });
});
