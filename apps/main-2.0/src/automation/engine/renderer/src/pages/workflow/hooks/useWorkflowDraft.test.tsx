// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppSnapshot } from "../../../../../shared/types";
import type { WorkflowV2Definition } from "../../../../../shared/workflow-v2/definition";
import type { WorkflowService } from "../../../app/services/workflow-service";
import { useWorkflowDraft, type WorkflowDraftController } from "./useWorkflowDraft";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

describe("useWorkflowDraft", () => {
  test("asks the Manager Agent to generate the graph instead of patching an empty definition", async () => {
    const definition: WorkflowV2Definition = {
      workflowId: "wf-generate",
      graphVersion: 1,
      objective: "Generate a workflow",
      nodes: [],
      edges: [],
    };
    const snapshot = {
      workflowDraft: {
        workflowId: definition.workflowId,
        sourceType: "user",
        topologyLocked: false,
        title: "Generate",
        status: "draft",
        revision: 1,
        configuredAgentId: "manager",
        modelId: "model",
        reviewerConfiguredAgentId: "",
        reviewerModelId: "",
        objective: definition.objective,
        definition,
        messages: [{ id: "question", role: "assistant", content: "Any final constraints?" }],
        reply: "",
        runProgress: [],
        runContextDocument: "",
        contextDocument: "",
        runIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    } as unknown as AppSnapshot;
    const sendDraftReply = vi.fn(async () => snapshot);
    const patchDraft = vi.fn(async () => snapshot);
    const workflows = { sendDraftReply, patchDraft } as unknown as WorkflowService;
    const snapshotRef = { current: snapshot };
    let controller: WorkflowDraftController | undefined;

    function Harness(): ReactElement | null {
      controller = useWorkflowDraft({
        snapshot,
        setSnapshot: vi.fn(),
        snapshotRef,
        initialWorkflowDefinition: definition,
        workflows,
        configuredAgents: [],
        channels: [],
      });
      return null;
    }

    const root = createRoot(document.createElement("div"));
    roots.push(root);
    await act(async () => root.render(<Harness />));
    await act(async () => controller!.buildWorkflowDefinition("保留最终报告节点"));

    expect(patchDraft).not.toHaveBeenCalled();
    expect(sendDraftReply).toHaveBeenCalledWith({
      workflowId: definition.workflowId,
      reply: expect.stringMatching(/补充信息：保留最终报告节点[\s\S]*必须调用 workflow_create[\s\S]*不要继续提问/),
    });
  });
});
