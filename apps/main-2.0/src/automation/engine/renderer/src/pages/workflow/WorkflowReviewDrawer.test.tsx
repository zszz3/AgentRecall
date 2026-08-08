// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkflowV2GenerationReviewState } from "../../../../shared/workflow-v2/generation-review";
import { WorkflowReviewDrawer } from "./WorkflowReviewDrawer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const review: WorkflowV2GenerationReviewState = {
  status: "changes_requested",
  reviewerConfiguredAgentId: "reviewer",
  reviewerModelId: "model",
  reviewedRevision: 2,
  result: {
    verdict: "revise",
    reviewedRevision: 2,
    summary: "Revise the workflow.",
    findings: [],
    scriptRisks: {},
    suggestions: [],
  },
  updatedAt: 1,
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("WorkflowReviewDrawer", () => {
  test("shows a clear sent state after handing review findings to the Manager", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let resolveApply: (() => void) | undefined;
    const pendingApply = new Promise<void>((resolve) => { resolveApply = resolve; });
    const onApplyReview = vi.fn(() => pendingApply);

    await act(async () => {
      root.render(<WorkflowReviewDrawer
        open
        review={review}
        reviewerControls={null}
        canReview
        canInterrupt={false}
        canApplyReview
        onReview={() => undefined}
        onApplyReview={onApplyReview}
        onInterrupt={() => undefined}
        onClose={() => undefined}
      />);
    });

    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.includes("Ask Manager to revise"));
    expect(button).toBeDefined();
    await act(async () => button?.click());

    expect(onApplyReview).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Sent to Manager");
    expect(container.textContent).toContain("Review result sent. Manager Agent is revising this Workflow.");
    expect(button?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveApply?.();
      await pendingApply;
    });
    expect(container.textContent).toContain("Ask Manager to revise");
    expect(button?.hasAttribute("disabled")).toBe(false);

    await act(async () => root.unmount());
  });
});
