import { describe, expect, it } from "vitest";
import { DEFAULT_SNAPSHOT } from "../../../../automation/engine/renderer/src/app/app-state";
import type { AutomationChange } from "../../../../shared/ipc/automation";
import { applyAutomationChange } from "./automation-change";

function change(sequence: number): AutomationChange {
  return {
    protocolVersion: 1,
    sequence,
    detectedAt: sequence,
    domain: "workflow",
    entityId: "workflow-state",
    operation: "patch",
    payload: {
      activeWorkflowId: "wf",
    },
  };
}

describe("applyAutomationChange", () => {
  it("applies a workflow projection without replacing unrelated state", () => {
    const snapshot = { ...DEFAULT_SNAPSHOT, workDir: "C:/repo", chats: [{ id: "chat" }] as never };
    const result = applyAutomationChange(snapshot, change(7), undefined);

    expect(result.resyncRequired).toBe(false);
    expect(result.snapshot.workDir).toBe("C:/repo");
    expect(result.snapshot.chats).toBe(snapshot.chats);
    expect(result.snapshot.workflowStore.activeWorkflowId).toBe("wf");
  });

  it("requires resync when an established sequence has a gap", () => {
    const result = applyAutomationChange(DEFAULT_SNAPSHOT, change(4), 2);

    expect(result.resyncRequired).toBe(true);
    expect(result.snapshot).toBe(DEFAULT_SNAPSHOT);
  });

  it("ignores duplicate or stale changes without mutating state", () => {
    const result = applyAutomationChange(DEFAULT_SNAPSHOT, change(2), 2);

    expect(result.resyncRequired).toBe(false);
    expect(result.snapshot).toBe(DEFAULT_SNAPSHOT);
    expect(result.sequence).toBe(2);
  });

  it("preserves the workflow definition reference for message-only revisions", () => {
    const definition = { version: 2, objective: "test", nodes: [], edges: [] };
    const workflow = { workflowId: "wf", revision: 3, createdAt: 1, definition, messages: [] };
    const snapshot = {
      ...DEFAULT_SNAPSHOT,
      workflowStore: { activeWorkflowId: "wf", workflows: [workflow], runs: [] },
      workflowDraft: workflow,
    } as never;
    const event = change(1);
    event.payload.workflows = {
      upsert: [{ ...workflow, definition: structuredClone(definition), messages: [{ id: "message" }] } as never],
      remove: [],
    };

    const result = applyAutomationChange(snapshot, event, undefined);

    expect(result.snapshot.workflowDraft?.definition).toBe(definition);
  });

  it("preserves and updates derived Workflow readiness across incremental events", () => {
    const snapshot = { ...DEFAULT_SNAPSHOT, workflowStore: { ...DEFAULT_SNAPSHOT.workflowStore, readinessByWorkflowId: { wf: { ready: false, issues: [] } } } };
    const unrelated = applyAutomationChange(snapshot, change(1), undefined);
    expect(unrelated.snapshot.workflowStore.readinessByWorkflowId).toEqual(snapshot.workflowStore.readinessByWorkflowId);

    const readinessChange = change(2);
    readinessChange.payload.readinessByWorkflowId = { wf: { ready: true, issues: [] } };
    const updated = applyAutomationChange(unrelated.snapshot, readinessChange, 1);
    expect(updated.snapshot.workflowStore.readinessByWorkflowId).toEqual({ wf: { ready: true, issues: [] } });
  });
});
