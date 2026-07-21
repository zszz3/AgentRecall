import { describe, expect, test } from "vitest";

import type { WorkflowV2Definition } from "./definition";
import { createWorkflowV2RunState } from "./state";
import {
  isWorkflowV2CacheEntryMetadata,
  isWorkflowV2NodeCacheFingerprint,
  isWorkflowV2PersistedRunState,
  sameWorkflowV2CacheFingerprint,
  type WorkflowV2NodeCacheFingerprint,
  WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
} from "./storage";

function fingerprint(): WorkflowV2NodeCacheFingerprint {
  return {
    graphVersion: 3,
    nodeDefinitionHash: "node-hash",
    upstreamOutputHash: "upstream-hash",
    modelProfile: "expert",
    role: "reviewer",
    requiredToolsHash: "tools-hash",
    executionEnvHash: "environment-hash",
    reviewerPolicyHash: "review-policy-hash",
    templateVersion: "template-v1",
  };
}

describe("workflow-v2 storage contracts", () => {
  test("validates complete cache fingerprints", () => {
    expect(isWorkflowV2NodeCacheFingerprint(fingerprint())).toBe(true);
    expect(
      isWorkflowV2NodeCacheFingerprint({ ...fingerprint(), upstreamOutputHash: "" }),
    ).toBe(false);
  });

  test("requires every effective execution input to match before cache reuse", () => {
    const expected = fingerprint();
    expect(sameWorkflowV2CacheFingerprint(expected, { ...expected })).toBe(true);
    expect(sameWorkflowV2CacheFingerprint(expected, { ...expected, graphVersion: 4 })).toBe(false);
    expect(
      sameWorkflowV2CacheFingerprint(expected, { ...expected, reviewerPolicyHash: "changed" }),
    ).toBe(false);
    expect(
      sameWorkflowV2CacheFingerprint(expected, { ...expected, upstreamOutputHash: "changed" }),
    ).toBe(false);
  });

  test("rejects shallow or incompatible persisted run state", () => {
    const persisted = {
      schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
      workflowId: "workflow-1",
      runId: "run-1",
      graphVersion: 3,
      savedAt: 1_000,
      eventCount: 0,
      plan: {},
      runState: {},
      workerOutputs: [],
      nodeControl: {},
    };
    expect(isWorkflowV2PersistedRunState(persisted)).toBe(false);
    expect(isWorkflowV2PersistedRunState({ ...persisted, schemaVersion: 2 })).toBe(false);
  });

  test("rejects cache metadata whose output identity does not match its node", () => {
    expect(
      isWorkflowV2CacheEntryMetadata({
        schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
        workflowId: "workflow-1",
        nodeId: "node-1",
        graphVersion: 3,
        fingerprint: fingerprint(),
        output: { nodeId: "other-node", summary: "done", outputs: {}, proposals: [] },
        savedAt: 1_000,
      }),
    ).toBe(false);
  });

  test("accepts finite hook variables and rejects non-finite durable hook state", () => {
    const definition: WorkflowV2Definition = {
      workflowId: "workflow-1",
      graphVersion: 3,
      objective: "Persist hook state",
      nodes: [
        {
          id: "node-1",
          kind: "worker",
          title: "Worker",
          execModel: "llm",
          executionMode: "one-shot",
          prompt: "Run",
          outputFields: [{ key: "result", required: true }],
        },
      ],
      edges: [],
    };
    const plan = {
      workflowId: definition.workflowId,
      graphVersion: definition.graphVersion,
      objective: definition.objective,
      definition,
      nodes: [],
      acceptanceCriteria: [],
      roleDefaults: {},
      budget: { context: { maxContextTokens: 1 } },
      approvedBy: "tester",
      frozenAt: 1,
    };
    const persisted = {
      schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
      workflowId: definition.workflowId,
      runId: "run-1",
      graphVersion: definition.graphVersion,
      savedAt: 1,
      eventCount: 0,
      plan,
      runState: createWorkflowV2RunState({ definition }),
      workerOutputs: [],
      nodeControl: { "node-1": { extensionCount: 0, hookVariables: { risk: ["low", 1] } } },
    };

    expect(isWorkflowV2PersistedRunState(persisted)).toBe(true);
    expect(
      isWorkflowV2PersistedRunState({
        ...persisted,
        nodeControl: { "node-1": { extensionCount: 0, hookVariables: { risk: Number.NaN } } },
      }),
    ).toBe(false);
  });
});
