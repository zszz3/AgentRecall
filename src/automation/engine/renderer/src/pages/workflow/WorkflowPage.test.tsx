import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { WorkflowController } from "./workflow-controller";
import { WorkflowPage } from "./WorkflowPage";

function controller(definitionReady: boolean): WorkflowController {
  return {
    workflowId: "workflow", title: "Workflow", status: definitionReady ? "running" : "draft", definitionReady,
    definition: { workflowId: "workflow", graphVersion: 1, objective: "Answer a question", nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "interactive", prompt: "Answer the question.", outputFields: [{ key: "answer_markdown", required: true }] }], edges: [] },
    objective: "Answer a question", messages: [], reply: "", error: undefined, configuredAgentId: "default-agent", reviewerConfiguredAgentId: "reviewer-agent", runtimes: [], channels: [], workDir: "C:/workspace", running: definitionReady,
    activeRunId: definitionReady ? "run" : undefined, runProgress: definitionReady ? [{ nodeId: "answer", title: "Answer", status: "running" }] : [],
    onObjectiveChange: () => undefined, onSelectConfiguredAgent: () => undefined, onSelectReviewerConfiguredAgent: () => undefined, onBuildDefinition: () => undefined, onReplyChange: () => undefined, onSendReply: () => undefined, onUpdateNode: () => undefined, onRunWorkflow: () => undefined, onResetSession: () => undefined,
  };
}

describe("WorkflowPage input ownership", () => {
  test("renders the planning composer before a workflow graph exists", () => {
    expect(renderToStaticMarkup(<WorkflowPage controller={controller(false)} />)).toContain("workflow-composer");
  });
  test("removes the planning composer once node execution owns user input", () => {
    const html = renderToStaticMarkup(<WorkflowPage controller={controller(true)} />);
    expect(html).not.toContain("workflow-composer");
  });

  test("requires explicit confirmation before a valid draft can run", () => {
    const value = controller(true);
    value.status = "draft";
    value.running = false;
    value.activeRunId = undefined;
    value.runProgress = [];
    value.revision = 3;
    delete value.confirmedRevision;
    value.onConfirmWorkflow = () => undefined;
    value.onReviewWorkflow = () => undefined;
    const unconfirmedHtml = renderToStaticMarkup(<WorkflowPage controller={value} />);
    expect(unconfirmedHtml).toContain("Review");
    expect(unconfirmedHtml).toContain("workflow-command-cluster");
    expect(unconfirmedHtml).toContain("workflow-bottom-action-bar");
    expect(unconfirmedHtml).toContain("workflow-confirm-action");
    expect(unconfirmedHtml).toContain("Confirm workflow");
    expect(unconfirmedHtml).toContain("Awaiting confirmation");
    expect(unconfirmedHtml).toContain('class="send-btn workflow-run-action" disabled=""');
    expect(unconfirmedHtml.indexOf("workflow-composer")).toBeLessThan(unconfirmedHtml.indexOf("workflow-bottom-action-bar"));

    value.generationReview = { status: "approved", reviewerConfiguredAgentId: "reviewer-agent", reviewerModelId: "reviewer-model", reviewedRevision: 3, updatedAt: 1, result: { verdict: "approve", reviewedRevision: 3, summary: "Ready", findings: [], scriptRisks: {}, suggestions: [] } };
    value.reviewerModelId = "reviewer-model";
    value.confirmedRevision = 3;
    const confirmedHtml = renderToStaticMarkup(<WorkflowPage controller={value} />);
    expect(confirmedHtml).not.toContain("Confirm workflow");
    expect(confirmedHtml).toContain("Confirmed r3");
    expect(confirmedHtml).toContain('class="send-btn workflow-run-action"');
  });

  test("uses a compact review entry instead of an inline review panel", () => {
    const value = controller(true);
    value.status = "draft";
    value.running = false;
    value.activeRunId = undefined;
    value.runProgress = [];
    value.revision = 3;
    value.onReviewWorkflow = () => undefined;
    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);

    expect(html).toContain("Review");
    expect(html).toContain("workflow-review-trigger");
    expect(html).not.toContain("workflow-review-panel");
  });
  test("does not render the legacy inline gate input for an awaiting node", () => {
    const value = controller(true);
    value.runProgress = [{ nodeId: "answer", title: "Answer", status: "awaiting_input", detail: "Provide more context" }];
    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);
    expect(html).not.toContain("workflow-gate-panel");
    expect(html).not.toContain("workflow-gate-panel-input");
  });

  test("does not render the legacy intervention action panel for a paused node", () => {
    const value = controller(true);
    value.runProgress = [{
      nodeId: "answer",
      title: "Echo User Input",
      status: "paused",
      intervention: {
        nodeId: "answer",
        source: "supervision_pause",
        reason: "Interactive node is waiting for user confirmation.",
        allowedActions: ["continue", "skip", "escalate", "replan", "increase_review_strength"],
        requestedAt: 1,
      },
    }];
    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);
    expect(html).not.toContain("workflow-intervention-panel");
    expect(html).not.toContain("Interactive node is waiting for user confirmation.");
  });

  test("offers full workflow revision for a manually paused user workflow", () => {
    const value = controller(true);
    value.running = false;
    value.activeRunStatus = "waiting_for_user";
    value.runProgress = [{ nodeId: "answer", title: "Answer", status: "paused" }];
    value.onReviseRun = () => undefined;

    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);

    expect(html).toContain("Edit workflow and resume: Answer");
  });

  test("keeps conversation and manual editing available after a generated workflow finishes", () => {
    const value = controller(true);
    value.status = "completed";
    value.running = false;
    value.activeRunId = undefined;
    value.runProgress = [{ nodeId: "answer", title: "Answer", status: "completed" }];
    value.onUpdateDefinition = () => undefined;

    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);

    expect(html).toContain("workflow-composer");
    expect(html).toContain("Edit workflow definition");
  });
  test("renders an Agent selector directly on editable LLM node cards", () => {
    const value = controller(true);
    value.running = false;
    value.activeRunId = undefined;
    value.runProgress = [];
    value.configuredAgents = [{ id: "specialist", name: "Specialist", description: "", runtimeAgentId: "codex", channelId: "default", modelId: "gpt-specialist", tags: [], createdAt: 1, updatedAt: 1 }];
    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);
    expect(html).toContain("Agent for Answer");
    expect(html).toContain("Specialist");
    expect(html).toContain("Workflow default");
  });

  test("offers same-run revision after the latest run fails while keeping draft editing available", () => {
    const value = controller(true);
    value.running = false;
    value.activeRunStatus = "failed";
    value.runProgress = [{ nodeId: "answer", title: "Answer", status: "failed" }];
    value.onReviseRun = () => undefined;
    value.onUpdateDefinition = () => undefined;
    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);
    expect(html).toContain("Edit workflow and resume: Answer");
    expect(html).toContain("Edit workflow definition");
    expect(html).toContain("workflow-composer");
  });
  test("renders MCP failures independently from assistant Markdown", () => {
    const value = controller(false);
    value.messages = [{
      id: "assistant-1",
      role: "assistant",
      content: "I could not update the workflow.",
      events: [{
        id: "tool-1",
        type: "tool_result",
        name: "workflow_update",
        content: "Permission rejected by runtime host.",
        timestamp: 1,
        metadata: { status: "failed" },
      }],
    }];
    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);
    expect(html).toContain("workflow-tool-event");
    expect(html).toContain("workflow_update");
    expect(html).toContain("failed");
    expect(html).toContain("Permission rejected by runtime host.");
  });

  test("renders live Workflow Agent approvals with resolve actions", () => {
    const value = controller(false);
    value.onResolveRuntimeApproval = () => undefined;
    value.messages = [{
      id: "assistant-approval",
      role: "assistant",
      content: "Waiting for approval.",
      events: [{
        id: "approval-1",
        type: "approval_request",
        content: "Allow workflow_run?",
        timestamp: 1,
        requestId: "runtime-approval:1",
        requestState: "live",
      }],
    }];

    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);
    expect(html).toContain("runtime-approval-card");
    expect(html).toContain("Allow workflow_run?");
    expect(html).toContain("Approve once");
    expect(html).toContain("Reject");
  });

  test("offers run history from a separate floating action", () => {
    const value = controller(true);
    value.runs = [{
      runId: "run-1",
      workflowId: "workflow",
      status: "completed",
      workflowV2Plan: {} as never,
      progress: [],
      events: [],
      contextDocument: "",
      startedAt: 1,
      finishedAt: 2,
      lastError: undefined,
    }];

    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);

    expect(html).toContain("Open run history");
    expect(html).toContain("workflow-runs-fab");
    expect(html).toContain("<span>Runs</span>");
    expect(html).toContain("<em>1</em>");
    expect(html.indexOf("workflow-runs-fab")).toBeLessThan(html.indexOf("workflow-bottom-action-bar"));
  });

  test("moves active-run stop controls into the bottom action bar", () => {
    const value = controller(true);
    value.onStopRun = () => undefined;
    const html = renderToStaticMarkup(<WorkflowPage controller={value} />);

    expect(html).toContain("workflow-bottom-action-bar");
    expect(html).toContain("workflow-stop-action");
    expect(html).toContain("Stop workflow");
    expect(html).not.toContain("workflow-page-actions");
  });
});
