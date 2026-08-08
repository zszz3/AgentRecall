import { describe, expect, test } from "vitest";
import { PostgresDatabase } from "../../../../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../../../../core/postgres/schema";
import { PGliteTestPool } from "../../../../../core/postgres/test-pglite";
import { buildWorkflowV2PlanSync } from "../../workflows/v2/workflow-v2-planner";
import { PostgresWorkflowRepository } from "./postgres-workflow-repository";

describe("PostgresWorkflowRepository portable metadata", () => {
  test("round trips origin, rerun lineage, and execution-review fields", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    const repository = new PostgresWorkflowRepository();
    const origin = {
      importedFrom: { fileName: "fixture.agentrecall-workflow.json", workflowId: "source", title: "Source", revision: 4, importedAt: 10 },
      rootOrigin: { kind: "official", workflowId: "official", title: "Official", revision: 2, clonedAt: 5, trust: "file_claim" },
    };
    const definition = {
      workflowId: "wf-imported",
      graphVersion: 1,
      objective: "Objective",
      reviewEnabled: true,
      nodes: [{
        id: "answer",
        kind: "answer" as const,
        title: "Answer",
        execModel: "llm" as const,
        executionMode: "one-shot" as const,
        prompt: "Answer.",
        outputFields: [{ key: "answer", required: true }],
        reviewLevel: "high" as const,
        judgeDimensions: [{ key: "quality", description: "The answer must be correct." }],
      }],
      edges: [],
    };
    const workflowV2Plan = buildWorkflowV2PlanSync({ definition, approvedBy: "tester", now: 10 });
    const reviewHistory = [{
      reviewAttempt: 1,
      candidate: { nodeId: "answer", summary: "Candidate", outputs: { answer: "result" }, proposals: [] },
      verdict: {
        decision: "accept" as const,
        reasons: ["Correct."],
        riskLevel: "low" as const,
        confidence: "high" as const,
        qualityLevel: "high" as const,
        dimensionResults: [{ key: "quality", qualityLevel: "high" as const, reason: "Correct.", evidence: ["result"] }],
      },
      requiredLevel: "high" as const,
      passed: true,
      reviewedAt: 20,
      trace: [
        { id: "node-review-request", kind: "request" as const, at: 18, content: "Review this node" },
        { id: "node-review-response", kind: "response" as const, at: 19, content: "Accepted" },
      ],
    }];
    await repository.replace(database, {
      activeWorkflowId: "wf-imported",
      workflows: [{
        workflowId: "wf-imported", title: "Imported", status: "draft", revision: 3, confirmedRevision: 3,
        configuredAgentId: "agent", modelId: "model", reviewerConfiguredAgentId: "reviewer", reviewerModelId: "reviewer-model",
        objective: "Objective", reply: "", runContextDocument: "", contextDocument: "", messages: [], runProgress: [], runIds: ["run-child"],
        definition,
        sourceType: "user", topologyLocked: false, origin, generationReview: { status: "approved", reviewerConfiguredAgentId: "reviewer", reviewerModelId: "reviewer-model", reviewedRevision: 3, trace: [{ id: "global-review-request", kind: "request", at: 8, content: "Review this workflow" }], updatedAt: 10 },
        createdAt: 1, updatedAt: 2,
      }],
      runs: [{
        runId: "run-child",
        workflowId: "wf-imported",
        status: "completed",
        triggerSource: "rerun",
        parentRunId: "run-parent",
        workflowV2Plan,
        progress: [{ nodeId: "answer", title: "Answer", status: "completed_with_override", outputs: { answer: "result" }, reviewHistory }],
        contextDocument: "Context",
        events: [],
        startedAt: 10,
        finishedAt: 30,
      }],
    });

    const loaded = await repository.load(database, "wf-imported");
    expect((loaded.workflows as Array<Record<string, unknown>>)[0]).toMatchObject({ origin, confirmedRevision: 3, reviewerConfiguredAgentId: "reviewer", reviewerModelId: "reviewer-model", generationReview: { status: "approved", trace: [{ kind: "request", content: "Review this workflow" }] } });
    expect((loaded.runs as Array<Record<string, unknown>>)[0]).toMatchObject({
      runId: "run-child",
      parentRunId: "run-parent",
      triggerSource: "rerun",
      progress: [{ nodeId: "answer", status: "completed_with_override", reviewHistory }],
    });
    await database.close();
  });
});
