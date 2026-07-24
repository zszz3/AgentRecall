import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { WorkflowNodeAgentWindow } from "./WorkflowNodeAgentWindow";

describe("WorkflowNodeAgentWindow", () => {
  test("exposes the persisted node prompt for manual editing when the definition is editable", () => {
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow
      nodeTitle="Research"
      prompt="Research only official sources."
      editable
      onSavePrompt={() => undefined}
      onClose={() => undefined}
    />);
    expect(html).toContain("Agent node prompt editor");
    expect(html).toContain("Research only official sources.");
    expect(html).toContain("Edit prompt");
  });

  test("renders a queued agent node before runtime activity exists", () => {
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Collect requirements" onClose={() => undefined} />);
    expect(html).toContain("Node has not started yet");
    expect(html).toContain("has not produced runtime activity yet");
    expect(html).toContain("there is no active conversation yet");
  });

  test("renders durable agent activity and enables the independent composer", () => {
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow
      nodeTitle="Collect requirements"
      onClose={() => undefined}
      onSend={() => undefined}
      conversation={{
        conversationId: "workflow::run::collect",
        workflowId: "workflow",
        runId: "run",
        nodeId: "collect",
        configuredAgentId: "agent",
        modelId: "model",
        workDir: "C:/workspace",
        status: "waiting_for_user",
        messages: [{ id: "m1", role: "assistant", content: "Which regions should be supported?", at: 1, eventType: "delta" }],
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
      }}
    />);
    expect(html).toContain("Which regions should be supported?");
    expect(html).toContain("workflow::run::collect");
    expect(html).not.toContain("textarea disabled");
  });
  test("renders approval actions for interactive and one-shot workflow agents", () => {
    const conversationHtml = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Agent" onClose={() => undefined} onResolveRuntimeApproval={() => undefined} conversation={{
      conversationId: "w::r::n", workflowId: "w", runId: "r", nodeId: "n", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "active",
      messages: [{ id: "m1", role: "assistant", content: "Allow command?", at: 1, eventType: "approval_request", event: { id: "e1", type: "approval_request", content: "Allow command?", timestamp: 1, requestId: "approval-1", requestState: "live" } }], createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    }} />);
    expect(conversationHtml).toContain("Approve once");
    expect(conversationHtml).toContain("Reject");

    const taskHtml = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Agent" onClose={() => undefined} onResolveRuntimeApproval={() => undefined} task={{
      id: "task-1", title: "Agent", status: "running", progress: "in_progress", running: true, prompt: "Work", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", pendingAssistantMessageId: undefined, lastError: undefined, createdAt: 1, updatedAt: 1,
      messages: [{ id: "m1", role: "assistant", content: "", timestamp: 1, events: [{ id: "e1", type: "approval_request", content: "Allow command?", timestamp: 1, requestId: "approval-1", requestState: "live" }] }],
    }} />);
    expect(taskHtml).toContain("Approve once");
  });

  test("shows tool calls and results in the conversation timeline while keeping system instructions in runtime details", () => {
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Research" onClose={() => undefined} conversation={{
      conversationId: "workflow::run::research", workflowId: "workflow", runId: "run", nodeId: "research", configuredAgentId: "agent", modelId: "model", workDir: "C:/workspace", status: "active",
      messages: [
        { id: "m1", role: "system", content: "Research the topic", at: 1 },
        { id: "m2", role: "tool", content: "query", at: 2, eventType: "tool_call", name: "web_search" },
        { id: "m3", role: "tool", content: "3 results", at: 3, eventType: "tool_result", name: "web_search" },
      ], createdAt: 1, updatedAt: 4, lastActivityAt: 4,
    }} />);
    expect(html).toContain("System instruction");
    expect(html).toContain("Tool call");
    expect(html).toContain("Tool result");
    expect(html).toContain("web_search");
    expect(html).toContain("is-tool-call");
    expect(html).toContain("is-tool-result");
    expect(html).toContain("<details");
    expect(html).toContain("Runtime details");
    const runtimeDetailsAt = html.indexOf('<details class="workflow-node-agent-runtime-details"');
    expect(html.indexOf("Tool call")).toBeLessThan(runtimeDetailsAt);
    expect(html.slice(runtimeDetailsAt)).not.toContain("web_search");
  });

  test("labels workflow node completion as a structured result submission", () => {
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Research" onClose={() => undefined} conversation={{
      conversationId: "workflow::run::research", workflowId: "workflow", runId: "run", nodeId: "research", configuredAgentId: "agent", modelId: "model", workDir: "C:/workspace", status: "active",
      messages: [
        { id: "m1", role: "tool", content: '{"summary":"Done"}', at: 1, eventType: "tool_call", name: "workflow_node_complete" },
        { id: "m2", role: "system", content: "Runtime instruction", at: 2 },
      ], createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    }} />);

    expect(html).toContain("Structured result submitted");
    expect(html.indexOf("Structured result submitted")).toBeLessThan(html.indexOf('<details class="workflow-node-agent-runtime-details"'));
  });

  test("renders a worker-output packet as its user-facing Markdown output", () => {
    const content = JSON.stringify({ nodeId: "research", summary: "Done", outputs: { answer_markdown: "# Latest model\n\n**GPT-5.6 Sol**", source_links: ["https://developers.openai.com/api/docs/models"] }, evidence: [], risks: [], nextStepSuggestions: [], proposals: [] });
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Research" onClose={() => undefined} conversation={{
      conversationId: "workflow::run::research", workflowId: "workflow", runId: "run", nodeId: "research", configuredAgentId: "agent", modelId: "model", workDir: "C:/workspace", status: "completion_proposed",
      messages: [
        { id: "m1", role: "assistant", content, at: 1 },
        { id: "m2", role: "tool", content: '{"results":[{"title":"OpenAI models","count":3}]}', at: 2, eventType: "tool_result", name: "web_search" },
      ], completionProposal: { output: { nodeId: "research", summary: "Done", outputs: { answer_markdown: "# Latest model\n\n**GPT-5.6 Sol**" }, proposals: [] }, acceptanceCriteria: [], unresolvedRisks: [], proposedAt: 2 }, createdAt: 1, updatedAt: 2, lastActivityAt: 2,
    }} />);
    expect(html).toContain("<h1>Latest model</h1>");
    expect(html).toContain("<strong>GPT-5.6 Sol</strong>");
    expect(html).not.toContain("answer_markdown");
    expect(html).not.toContain("&quot;nodeId&quot;");
    expect(html).toContain("results");
  });

  test("renders a standard result packet without proposals as user-facing Markdown", () => {
    const content = JSON.stringify({ nodeId: "answer", summary: "Done", outputs: { answer_markdown: "# Final answer\n\nReadable result" }, evidence: [], risks: [] });
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Answer" onClose={() => undefined} conversation={{
      conversationId: "workflow::run::answer", workflowId: "workflow", runId: "run", nodeId: "answer", configuredAgentId: "agent", modelId: "model", workDir: "C:/workspace", status: "closed",
      messages: [{ id: "m1", role: "assistant", content, at: 1 }], createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    }} />);
    expect(html).toContain("<h1>Final answer</h1>");
    expect(html).toContain("Readable result");
    expect(html).not.toContain("answer_markdown");
    expect(html).not.toContain("&quot;nodeId&quot;");
  });

  test("does not offer completion actions after a proposal has already been closed", () => {
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Answer" onClose={() => undefined} conversation={{
      conversationId: "workflow::run::answer", workflowId: "workflow", runId: "run", nodeId: "answer", configuredAgentId: "agent", modelId: "model", workDir: "C:/workspace", status: "closed",
      messages: [], completionProposal: { output: { nodeId: "answer", summary: "Done", outputs: {}, proposals: [] }, acceptanceCriteria: [], unresolvedRisks: [], proposedAt: 1 }, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    }} />);

    expect(html).not.toContain("Confirm and continue");
    expect(html).not.toContain("Reject / request changes");
  });

  test("keeps agent progress text and renders the trailing packet as Markdown", () => {
    const content = `The question is clear. Using official docs first.${JSON.stringify({ nodeId: "web-search-answer", summary: "Verified", outputs: { answer_markdown: "## Answer\n\nGPT-5.6 Sol", source_links: ["https://developers.openai.com/api/docs/models"] }, evidence: [], risks: [], nextStepSuggestions: [], proposals: [] })}`;
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Answer" onClose={() => undefined} conversation={{
      conversationId: "w::r::answer", workflowId: "w", runId: "r", nodeId: "answer", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "completion_proposed",
      messages: [{ id: "m1", role: "assistant", content, at: 1 }], completionProposal: { output: { nodeId: "web-search-answer", summary: "Verified", outputs: { answer_markdown: "## Answer\n\nGPT-5.6 Sol" }, proposals: [] }, acceptanceCriteria: [], unresolvedRisks: [], proposedAt: 1 }, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    }} />);
    expect(html).toContain("The question is clear. Using official docs first.");
    expect(html).toContain("<h2>Answer</h2>");
    expect(html).toContain("GPT-5.6 Sol");
    expect(html).not.toContain("web-search-answer");
    expect(html).not.toContain("answer_markdown");
  });

  test("allows messaging an active interactive node before it explicitly asks for input", () => {
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Research" onClose={() => undefined} onSend={() => undefined} conversation={{
      conversationId: "w::r::research", workflowId: "w", runId: "r", nodeId: "research", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "active", messages: [], createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    }} />);
    expect(html).not.toContain("textarea disabled");
    expect(html).toContain("Send information to this node agent");
  });

  test("disables interrupt for a failed conversation", () => {
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow nodeTitle="Research" onClose={() => undefined} onInterrupt={() => undefined} conversation={{
      conversationId: "w::r::research", workflowId: "w", runId: "r", nodeId: "research", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "failed", messages: [], createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    }} />);
    expect(html).toContain('disabled="" title="Interrupt agent"');
  });
  test("renders a switchable queue for parallel node conversations", () => {
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow
      nodeTitle="Research"
      onClose={() => undefined}
      onSelectNode={() => undefined}
      selectedNodeId="research"
      sessions={[
        { nodeId: "collect", nodeTitle: "Collect requirements", conversation: { conversationId: "w::r::collect", workflowId: "w", runId: "r", nodeId: "collect", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "waiting_for_user", messages: [], createdAt: 1, updatedAt: 1, lastActivityAt: 1 } },
        { nodeId: "research", nodeTitle: "Research", conversation: { conversationId: "w::r::research", workflowId: "w", runId: "r", nodeId: "research", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "active", messages: [], createdAt: 1, updatedAt: 1, lastActivityAt: 1 } },
        { nodeId: "review", nodeTitle: "Review", conversation: { conversationId: "w::r::review", workflowId: "w", runId: "r", nodeId: "review", configuredAgentId: "a", modelId: "m", workDir: "C:/workspace", status: "completion_proposed", messages: [], completionProposal: { output: { nodeId: "review", summary: "Done", outputs: {}, evidence: [], proposals: [] }, acceptanceCriteria: [], unresolvedRisks: [], proposedAt: 1 }, createdAt: 1, updatedAt: 1, lastActivityAt: 1 } },
      ]}
    />);
    expect(html).toContain("2 nodes need attention");
    expect(html).toContain("Collect requirements");
    expect(html).toContain("Research");
    expect(html).toContain("Review");
    expect(html).toContain("is-selected");
    expect(html).toContain("Waiting for input");
    expect(html).toContain("Running");
    expect(html).toContain("Confirm completion");
  });});
