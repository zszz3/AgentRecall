import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { Bot, CheckCircle2, CircleStop, FileInput, GitBranch, Maximize2, Pencil, Play, RefreshCw, Send, ShieldAlert, Wand2, X } from "lucide-react";
import { DEFAULT_MODEL_ID } from "../../../../shared/models";
import { WORKFLOW_TOTAL_QUESTION_COUNT } from "../../../../shared/workflow-agent";
import { validateWorkflowV2Definition } from "../../../../shared/workflow-v2/validation";
import type { WorkflowV2Node } from "../../../../shared/workflow-v2/definition";
import type {
  AgentChannel,
  AgentRuntime,
  ConfiguredAgent,
  LocalFilePreview,
  RegisteredArtifact,
  WorkflowV2Definition,
  WorkflowGrillMessage,
  WorkflowRunProgressItem,
  WorkflowStatus,
} from "../../../../shared/types";
import {
  agentAccent,
  agentLabel,
  configuredAgentById,
  configuredAgentModel,
  configuredAgentRuntimeId,
  fallbackRuntime,
  resolveConfiguredAgentChannel,
  runtimeStatus,
} from "../../app/agents";
import { shouldSendComposerKey } from "../../app/composer";
import type { Language } from "../../app/language";
import { Markdown } from "../../Markdown";
import { ChatControls } from "../chat/ChatControls";
import { TaskStatusChip } from "../tasks/task-status";
import { WorkflowCanvasBoard } from "./WorkflowCanvasBoard";
import { WorkflowDraftEditorDialog } from "./WorkflowDraftEditorDialog";
import { WorkflowNodeAgentSelect } from "./WorkflowNodeAgentSelect";
import { WorkflowNodeSurface } from "./WorkflowNodeSurface";
import { WorkflowOutputPreviewModal } from "./WorkflowOutputPreviewModal";
import { WorkflowRevisionDialog } from "./WorkflowRevisionDialog";
import { WorkflowOutputsPanel } from "./WorkflowOutputsPanel";
import { WorkflowReviewDrawer } from "./WorkflowReviewDrawer";
import { WORKFLOW_TEXT } from "./workflow-text";
import type { WorkflowController } from "./workflow-controller";
import { workflowNodeOpenTarget } from "./workflow-node-open-policy";
import {
  WORKFLOW_THINKING_MESSAGE,
  truncateWorkflowContext,
  workflowAssistantDisplayContent,
  workflowRunProgressSummary,
  workflowRunStatusLabel,
} from "./workflow-utils";

export function WorkflowPage({ controller: source }: { controller: WorkflowController }) {
  const workflowId = source.workflowId;
  const topologyLocked = source.topologyLocked === true;
  const title = source.title;
  const status = source.status ?? "draft";
  const revision = source.revision;
  const confirmedRevision = source.confirmedRevision;
  const definition = source.definition;
  const graph = definition;
  const definitionReady = source.definitionReady;
  const objective = source.objective;
  const messages = source.messages;
  const reply = source.reply;
  const error = source.error;
  const configuredAgentId = source.configuredAgentId;
  const modelId = source.modelId ?? DEFAULT_MODEL_ID;
  const reviewerConfiguredAgentId = source.reviewerConfiguredAgentId;
  const reviewerModelId = source.reviewerModelId ?? DEFAULT_MODEL_ID;
  const generationReview = source.generationReview;
  const runtimes = source.runtimes;
  const channels = source.channels;
  const configuredAgents = source.configuredAgents ?? [];
  const workDir = source.workDir;
  const running = source.running;
  const runProgress = source.runProgress ?? [];
  const activeRunId = source.activeRunId;
  const artifacts = source.artifacts ?? [];
  const contextDocument = source.contextDocument ?? "";
  const finalReport = source.finalReport ?? "";
  const nodeConversations = source.nodeConversations ?? [];
  const nodeTasks = source.nodeTasks ?? [];
  const workflowV2Plan = source.workflowV2Plan;
  const onObjectiveChange = source.onObjectiveChange;
  const onPauseNode = source.onPauseNode;
  const onStopRun = source.onStopRun;
  const onStartNode = source.onStartNode;
  const onSubmitScriptInput = source.onSubmitScriptInput;
  const onResolveIntervention = source.onResolveIntervention;
  const onSendNodeMessage = source.onSendNodeMessage;
  const onCompleteNodeConversation = source.onCompleteNodeConversation;
  const onRejectNodeCompletion = source.onRejectNodeCompletion;
  const onInterruptNodeConversation = source.onInterruptNodeConversation;
  const onSelectConfiguredAgent = source.onSelectConfiguredAgent;
  const onSelectModel = source.onSelectModel ?? (() => undefined);
  const onSelectReviewerConfiguredAgent = source.onSelectReviewerConfiguredAgent;
  const onSelectReviewerModel = source.onSelectReviewerModel ?? (() => undefined);
  const onReviewWorkflow = source.onReviewWorkflow;
  const onBuildDefinition = source.onBuildDefinition;
  const onReplyChange = source.onReplyChange;
  const onSendReply = source.onSendReply;
  const onUpdateDefinition = source.onUpdateDefinition;
  const onReviseRun = source.onReviseRun;
  const onRunWorkflow = source.onRunWorkflow;
  const onConfirmWorkflow = source.onConfirmWorkflow;
  const onStopGrill = source.onStopGrill ?? (() => undefined);
  const onChooseWorkDir = source.onChooseWorkDir ?? (() => undefined);
  const onReadOutputFile = source.onReadOutputFile;
  const onListOutputs = source.onListOutputs;
  const language = source.language ?? "en";
  const defaultGraphExpanded = source.defaultGraphExpanded ?? false;
  const workflowText = WORKFLOW_TEXT[language];
  const validation = validateWorkflowV2Definition(definition);
  const workflowConfirmed = revision !== undefined && confirmedRevision === revision;
  const runOwnsInput = Boolean(activeRunId && (!source.activeRunStatus || source.activeRunStatus === "running" || source.activeRunStatus === "waiting_for_user"));
  const canEditDefinition = !runOwnsInput && !topologyLocked && !running;
  const [reviewDrawerOpen, setReviewDrawerOpen] = useState(false);
  const [draftEditorOpen, setDraftEditorOpen] = useState(false);

  useEffect(() => {
    if (generationReview?.status === "reviewing") setReviewDrawerOpen(true);
  }, [generationReview?.status]);
  const workflowStarted = messages.length > 0;
  const grillComplete = Math.max(0, messages.filter((message) => message.role === "user").length - 1) >= WORKFLOW_TOTAL_QUESTION_COUNT;
  const runtimeMap = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  const workflowConfiguredAgent = configuredAgentById(configuredAgentId, configuredAgents);
  const workflowChannel = resolveConfiguredAgentChannel(workflowConfiguredAgent, channels);
  const workflowRuntimeId = configuredAgentRuntimeId(workflowConfiguredAgent, workflowChannel);
  const workflowRuntime = runtimeMap.get(workflowRuntimeId) ?? fallbackRuntime(workflowRuntimeId);
  const workflowModel = configuredAgentModel(workflowConfiguredAgent, workflowChannel, modelId);
  const workflowConfigTitle = [
    workflowConfiguredAgent?.name,
    workflowChannel?.label,
    workflowModel?.label ?? workflowConfiguredAgent?.modelId ?? DEFAULT_MODEL_ID,
    runtimeStatus(workflowRuntime),
  ]
    .filter(Boolean)
    .join(" · ");
  const runProgressByNodeId = new Map(runProgress.map((item) => [item.nodeId, item]));
  const runProgressVisible = runProgress.length > 0;
  const contextDocumentVisible = contextDocument.trim().length > 0;
  const finalReportVisible = finalReport.trim().length > 0;
  const runProgressSignature = runProgress.map((item) => `${item.nodeId}:${item.status}`).join("|");
  const graphVisible = definitionReady || runProgressVisible || contextDocumentVisible || finalReportVisible;
  const workflowDisplayTitle = title?.trim() || (definitionReady ? graph.objective || "Untitled workflow" : "New workflow");
  const composerValue = workflowStarted ? reply : objective;
  const composerPlaceholder = workflowStarted
    ? graphVisible
      ? workflowText.modifyPlaceholder
      : workflowText.answerPlaceholder
    : workflowText.taskPlaceholder;
  const composerCanSend = Boolean(composerValue.trim()) && !running;
  const composerLocked = workflowStarted || running;
  const [graphExpanded, setGraphExpanded] = useState(defaultGraphExpanded);
  const [outputFiles, setOutputFiles] = useState<Array<{ name: string; path: string }>>([]);
  const [openNodeId, setOpenNodeId] = useState<string | undefined>(undefined);
  const [revisionEditorNodeId, setRevisionEditorNodeId] = useState<string | undefined>(undefined);
  const dismissedNodeSurfaceRunIdRef = useRef<string | undefined>(undefined);
  const [filePreview, setFilePreview] = useState<LocalFilePreview | undefined>(undefined);
  const [filePreviewError, setFilePreviewError] = useState<string | undefined>(undefined);
  const [filePreviewLoadingPath, setFilePreviewLoadingPath] = useState<string | undefined>(undefined);
  const outputDocuments = outputFiles.map((file) => ({ path: file.path, title: file.name }));
  const grillTranscriptRef = useRef<HTMLElement>(null);
  const grillStickRef = useRef(true);
  const openNodeConversation = nodeConversations.find((conversation) => conversation.nodeId === openNodeId);
  const openNodeGraphNode = graph.nodes.find((node) => node.id === openNodeId);
  const openNodeProgress = openNodeId ? runProgressByNodeId.get(openNodeId) : undefined;
  const openNodeTaskId = openNodeId ? runProgressByNodeId.get(openNodeId)?.taskId : undefined;
  const openNodeTask = nodeTasks.find((task) => task.id === openNodeTaskId);
  const nodeAgentSessions = graph.nodes.filter((node) => node.execModel === "llm").map((node) => {
    const conversation = nodeConversations.find((candidate) => candidate.nodeId === node.id);
    const taskId = runProgressByNodeId.get(node.id)?.taskId;
    const task = taskId ? nodeTasks.find((candidate) => candidate.id === taskId) : undefined;
    return { nodeId: node.id, nodeTitle: node.title, ...(conversation ? { conversation } : {}), ...(task ? { task } : {}) };
  });
  const nodePositionProps = {};

  useEffect(() => {
    if (dismissedNodeSurfaceRunIdRef.current && dismissedNodeSurfaceRunIdRef.current !== activeRunId) dismissedNodeSurfaceRunIdRef.current = undefined;
    const attentionConversation = nodeConversations.find((conversation) => conversation.status === "waiting_for_user" || conversation.status === "completion_proposed");
    if (attentionConversation && !openNodeId && dismissedNodeSurfaceRunIdRef.current !== activeRunId) setOpenNodeId(attentionConversation.nodeId);
  }, [activeRunId, nodeConversations, openNodeId]);

  useEffect(() => {
    const nodeInput = runProgress.find((item) => item.inputRequest);
    if (nodeInput && !openNodeId && dismissedNodeSurfaceRunIdRef.current !== activeRunId) setOpenNodeId(nodeInput.nodeId);
  }, [activeRunId, openNodeId, runProgress]);

  useEffect(() => {
    const approval = runProgress.find((item) => item.intervention?.source === "script_permission");
    if (approval && !openNodeId && dismissedNodeSurfaceRunIdRef.current !== activeRunId) setOpenNodeId(approval.nodeId);
  }, [activeRunId, openNodeId, runProgress]);

  useEffect(() => {
    const transcript = grillTranscriptRef.current;
    if (!transcript || !grillStickRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  // List actual files in the workflow's outputs directory, so produced documents
  // are always visible regardless of run state (not scraped from run text).
  useEffect(() => {
    if (typeof onListOutputs !== "function") {
      setOutputFiles([]);
      return;
    }
    let cancelled = false;
    void onListOutputs()
      .then((files) => {
        if (!cancelled) setOutputFiles(files);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, status, finalReport, runProgressSignature]);

  useEffect(() => {
    if (!graphExpanded) return;
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpenNodeId(undefined);
        setGraphExpanded(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [graphExpanded]);

  useEffect(() => {
    if (!filePreview) return;
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") setFilePreview(undefined);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filePreview]);

  function handleGrillTranscriptScroll(): void {
    const transcript = grillTranscriptRef.current;
    if (!transcript) return;
    grillStickRef.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
  }

  async function openOutputDocument(filePath: string): Promise<void> {
    if (!onReadOutputFile) {
      setFilePreviewError("当前环境不支持应用内文件预览。");
      return;
    }
    setFilePreviewError(undefined);
    setFilePreviewLoadingPath(filePath);
    try {
      setFilePreview(await onReadOutputFile(filePath));
    } catch (error) {
      setFilePreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setFilePreviewLoadingPath(undefined);
    }
  }

  function renderWorkflowNodeCard(node: WorkflowV2Node, compact: boolean): ReactElement {
    const nodeRunProgress = runProgressByNodeId.get(node.id);
    const nodeAgentId = node.execModel === "llm" ? node.configuredAgentId ?? configuredAgentId : configuredAgentId;
    const nodeAgentConfig = configuredAgentById(nodeAgentId, configuredAgents);
    const nodeAgentName = nodeAgentConfig?.name || nodeAgentId || "default";
    const nodeModelId = node.execModel === "llm" ? node.modelId ?? nodeAgentConfig?.modelId ?? modelId : "script";
    const canConfigureNodeAgent = node.execModel === "llm" && canEditDefinition;
    const nodeAgentRow =
      node.execModel === "llm" ? (
        <div className="workflow-node-agent-row" title={`Agent: ${nodeAgentName} · Model: ${nodeModelId}`}>
          {canConfigureNodeAgent ? <WorkflowNodeAgentSelect nodeTitle={node.title} {...(node.configuredAgentId ? { configuredAgentId: node.configuredAgentId } : {})} workflowDefaultAgentId={configuredAgentId} configuredAgents={configuredAgents} onSelect={(selectedAgentId) => { void source.onUpdateNode(node.id, { configuredAgentId: selectedAgentId, modelId: undefined } as Partial<WorkflowV2Node>); }} /> : <><span className="workflow-node-agent-name">{nodeAgentName}</span><span className="workflow-node-agent-model">{nodeModelId}</span></>}
        </div>
      ) : null;

    const NodeKindIcon = node.execModel === "script" ? FileInput : Bot;
    const openNodeEditor = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const surface = workflowNodeOpenTarget(node.execModel);
      setOpenNodeId(node.id);
      if (surface === "script") setGraphExpanded(false);
    };
    const cardHead = (
      <div className="workflow-graph-card-head">
        <span className="workflow-node-type-icon" data-kind={node.execModel} aria-hidden="true">
          <NodeKindIcon size={15} strokeWidth={2.2} />
        </span>
        <div className="workflow-graph-card-headings">
          <span className="workflow-node-type-label">{node.execModel}</span>
          <strong>{node.title}</strong>
        </div>
        {nodeRunProgress ? <em className={`workflow-node-run-pill is-${nodeRunProgress.status}`}>{workflowRunStatusLabel(nodeRunProgress.status)}</em> : null}
      </div>
    );

    if (compact) {
      return (
        <article
          className={`workflow-graph-card workflow-canvas-node-card is-${node.execModel} ${nodeRunProgress ? `run-${nodeRunProgress.status}` : ""}`}
          onClick={openNodeEditor}
          onContextMenu={openNodeEditor}
          title="Click to view details"
        >
          {cardHead}
          {nodeAgentRow}
          {nodeRunProgress?.detail ? <div className={`workflow-node-run-detail is-${nodeRunProgress.status}`}>{nodeRunProgress.detail}</div> : null}
        </article>
      );
    }

    return (
      <article
        className={`workflow-graph-card workflow-canvas-node-card workflow-expanded-node-card is-${node.execModel} ${nodeRunProgress ? `run-${nodeRunProgress.status}` : ""}`}
        onClick={openNodeEditor}
        onContextMenu={openNodeEditor}
        title="Click to view details"
      >
        {cardHead}
        {nodeAgentRow}
        {nodeRunProgress?.detail ? <div className={`workflow-node-run-detail is-${nodeRunProgress.status}`}>{nodeRunProgress.detail}</div> : null}
      </article>
    );
  }

  return (
    <>
      <header className="chat-header workflow-chat-header">
        <div className="chat-title-block">
          <h2>{workflowDisplayTitle}</h2>
          <div className="chat-subtitle">
            <span className={`agent-badge mini ${agentAccent(workflowRuntimeId)}`} title={workflowConfigTitle}>
              {workflowConfiguredAgent?.name || agentLabel(workflowRuntimeId)}
            </span>
            <span>{graphVisible ? `${definition?.nodes.length ?? 0} ${workflowText.executableNodes}` : status}</span>
            <button
              type="button"
              className="workflow-workdir-button"
              onClick={() => void onChooseWorkDir()}
              disabled={running}
              title={workDir || workflowText.noWorkDir}
            >
              {workDir || workflowText.noWorkDir}
            </button>
          </div>
        </div>
        <div className="chat-header-actions workflow-page-actions">
          {running && !activeRunId ? (
            <button className="icon-btn danger" onClick={() => onStopGrill()} title="Stop agent">
              <CircleStop size={14} />
            </button>
          ) : null}
          {graphVisible ? (
            running && activeRunId && onStopRun ? (
              <button className="control-btn danger" onClick={() => { if (window.confirm("Stop this workflow run? Completed work and history will be preserved, but this run cannot resume.")) void onStopRun(); }}>
                <CircleStop size={14} />
                <span>Stop workflow</span>
              </button>
            ) : <>
              {onReviewWorkflow ? (
                <button
                  className={`control-btn workflow-review-trigger is-${generationReview?.status ?? "not_reviewed"}`}
                  onClick={() => setReviewDrawerOpen(true)}
                  aria-haspopup="dialog"
                  aria-expanded={reviewDrawerOpen}
                >
                  {generationReview?.status === "approved" ? <CheckCircle2 size={14} /> : generationReview?.status === "changes_requested" || generationReview?.status === "failed" ? <ShieldAlert size={14} /> : <RefreshCw size={14} className={generationReview?.status === "reviewing" ? "is-spinning" : ""} />}
                  <span>{generationReview?.status === "reviewing" ? "Review running" : "Review Agent"}</span>
                </button>
              ) : null}
              {!workflowConfirmed && onConfirmWorkflow ? (
          <button className="control-btn" onClick={() => void onConfirmWorkflow()} disabled={!validation.valid || running}>
                  <span>{workflowText.confirmWorkflow}</span>
                </button>
              ) : null}
              <button className="send-btn" onClick={() => void onRunWorkflow()} disabled={!validation.valid || !workflowConfirmed || running}>
                <Play size={14} />
                <span>{workflowText.runWorkflow}</span>
              </button>
            </>
          ) : null}
        </div>
      </header>

      {graphVisible && onReviewWorkflow ? <WorkflowReviewDrawer
        open={reviewDrawerOpen}
        {...(generationReview ? { review: generationReview } : {})}
        reviewerControls={<ChatControls
          configuredAgentId={reviewerConfiguredAgentId}
          modelId={reviewerModelId}
          configuredAgents={configuredAgents}
          channels={channels}
          locked={running || generationReview?.status === "reviewing"}
          running={running}
          workDir={workDir}
          runtimes={runtimes}
          onSelectConfiguredAgent={onSelectReviewerConfiguredAgent}
          onSelectModel={onSelectReviewerModel}
          onChooseWorkDir={onChooseWorkDir}
        />}
        canReview={validation.valid && !running}
        canInterrupt={generationReview?.status === "reviewing"}
        onReview={() => void onReviewWorkflow()}
        onInterrupt={() => void source.onInterruptWorkflowReview?.()}
        onClose={() => setReviewDrawerOpen(false)}
      /> : null}

      <section className="cli-transcript workflow-transcript" aria-label="Workflow transcript" ref={grillTranscriptRef} onScroll={handleGrillTranscriptScroll}>
        {!workflowStarted && !graphVisible ? (
          <div className="empty-state terminal-empty">
            <GitBranch size={17} />
            <span>{workflowText.empty}</span>
          </div>
        ) : workflowStarted ? (
          messages.map((message) => (
            <div key={message.id} className={`cli-message ${message.role}`}>
              <div className="cli-agent-line">
                {message.role === "assistant" ? <span className={`runtime-dot ${agentAccent(workflowRuntimeId)}`} /> : null}
                <span>{message.role === "assistant" ? "Workflow agent" : "You"}</span>
              </div>
              {message.role === "user" ? (
                <div className="cli-markdown">
                  <Markdown text={message.content} />
                </div>
              ) : (
                <div className={`cli-markdown ${running && message.content === WORKFLOW_THINKING_MESSAGE ? "is-streaming" : ""}`}>
                  <Markdown text={workflowAssistantDisplayContent(message.content)} />
                  {running && message.content === WORKFLOW_THINKING_MESSAGE ? <span className="stream-cursor" aria-hidden="true" /> : null}
                </div>
              )}
            </div>
          ))
        ) : null}
        {running && !graphVisible ? (
          <div className="cli-status-line">
            <span className="stream-pill">
              <span className="stream-spinner" aria-hidden="true" />
              <span>{`${workflowConfiguredAgent?.name || agentLabel(workflowRuntimeId)} ${workflowText.agentWorking}`}</span>
            </span>
          </div>
        ) : null}
        {error ? <div className="workflow-error workflow-inline-error">{error}</div> : null}
        {graphVisible ? (
          <section className="workflow-result-card" aria-label={workflowText.result}>
            <div className="workflow-result-card-head">
              <div>
                <strong>{graph.objective || "Untitled workflow"}</strong>
                <span>{validation.valid ? workflowText.dagValid : workflowText.dagInvalid}</span>
              </div>
              <div className="workflow-validation-row-actions">
                {!runOwnsInput && !topologyLocked && onUpdateDefinition ? <button className="icon-btn flat" onClick={() => setDraftEditorOpen(true)} title="Edit workflow definition" aria-label="Edit workflow definition" disabled={running}><Pencil size={14} /></button> : null}
                <TaskStatusChip
                  label={!validation.valid ? workflowText.invalid : workflowConfirmed ? `${workflowText.confirmed} r${confirmedRevision}` : workflowText.awaitingConfirmation}
                  tone={!validation.valid ? "failed" : workflowConfirmed ? "done" : "running"}
                />
                <button className="icon-btn flat" onClick={() => setGraphExpanded(true)} title="Expand graph board" aria-label="Expand workflow graph board">
                  <Maximize2 size={14} />
                </button>
              </div>
            </div>
            {validation.errors.length > 0 ? (
              <div className="workflow-validation-errors">
                {validation.errors.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            ) : null}
            {graphExpanded ? (
              <>
                <div className="workflow-graph-backdrop" onClick={() => setGraphExpanded(false)} />
                <button className="workflow-graph-close icon-btn" onClick={() => setGraphExpanded(false)} title="Close graph board" aria-label="Close workflow graph board">
                  <X size={15} />
                </button>
                {definition ? <WorkflowCanvasBoard definition={definition} expanded onOpenNode={setOpenNodeId} renderNodeCard={(node) => renderWorkflowNodeCard(node, false)} /> : null}
              </>
            ) : (
              definition ? <WorkflowCanvasBoard definition={definition} runProgressByNodeId={runProgressByNodeId} onOpenNode={setOpenNodeId} onExpand={() => setGraphExpanded(true)} renderNodeCard={(node) => renderWorkflowNodeCard(node, true)} /> : null
            )}
            {runProgressVisible ? (
              <section className="workflow-run-progress" aria-label={workflowText.runProgress}>
                <div className="workflow-run-progress-head">
                  <strong>{workflowText.runProgress}</strong>
                  <span>{workflowRunProgressSummary(runProgress)}</span>
                </div>
                <div className="workflow-run-progress-list">
                  {runProgress.map((item) => {
                    const controllable = Boolean(activeRunId);
                    const canPause = controllable && item.status === "running" && typeof onPauseNode === "function";
                    const canStart = controllable
                      && (item.status === "paused" || item.status === "failed")
                      && !item.intervention
                      && typeof onStartNode === "function";
                    const runCanRevise = source.activeRunStatus === "waiting_for_user" || source.activeRunStatus === "stopped" || source.activeRunStatus === "failed";
                    const canRevise = controllable && runCanRevise && (item.status === "paused" || item.status === "failed") && typeof onReviseRun === "function" && !topologyLocked && !item.intervention;
                    return (
                      <div key={item.nodeId} className={`workflow-run-progress-item is-${item.status}`}>
                        <span>{workflowRunStatusLabel(item.status)}</span>
                        <strong>{item.title}</strong>
                        {item.detail ? <small>{item.detail}</small> : null}
                        {canPause ? (
                          <button
                            type="button"
                            className="workflow-node-control icon-btn"
                            onClick={() => void onPauseNode?.(item.nodeId)}
                            title={workflowText.pauseNode}
                            aria-label={`${workflowText.pauseNode}: ${item.title}`}
                          >
                            <CircleStop size={14} />
                          </button>
                        ) : null}
                        {canStart ? (
                          <button
                            type="button"
                            className="workflow-node-control icon-btn"
                            onClick={() => void onStartNode?.(item.nodeId)}
                            title={workflowText.startNode}
                            aria-label={`${workflowText.startNode}: ${item.title}`}
                          >
                            <Play size={14} />
                          </button>
                        ) : null}
                        {canRevise ? (
                          <button type="button" className="workflow-node-control icon-btn" onClick={() => setRevisionEditorNodeId(item.nodeId)} title="Edit workflow and resume" aria-label={`Edit workflow and resume: ${item.title}`}>
                            <Pencil size={14} />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
            {runProgressVisible ? <section className="workflow-leader-activity" aria-label="Leader Activity">
              <header><strong>Leader Activity</strong><span>{runProgress.some((item) => item.status === "failed") ? "blocked" : runProgress.some((item) => item.status === "paused" || item.status === "awaiting_input") ? "at-risk" : "healthy"}</span></header>
              <div><b>Priorities</b><p>{runProgress.filter((item) => item.status === "running" || item.status === "queued").map((item) => item.title).join(" ? ") || "No runnable priority"}</p></div>
              <div><b>Blocked / user action</b><p>{runProgress.filter((item) => item.status === "paused" || item.status === "awaiting_input").map((item) => `${item.title}: ${item.detail || "waiting for input"}`).join(" ? ") || "None"}</p></div>
            </section> : null}
            <WorkflowOutputsPanel
              finalReport={finalReport}
              artifacts={artifacts}
              documents={outputDocuments}
              loadingPath={filePreviewLoadingPath}
              error={filePreviewError}
              text={workflowText}
              onOpenDocument={openOutputDocument}
            />
          </section>
        ) : null}
      </section>

      {filePreview ? <WorkflowOutputPreviewModal
        preview={filePreview}
        closeLabel={workflowText.closePreview}
        truncatedLabel={workflowText.largeFile}
        onClose={() => setFilePreview(undefined)}
      /> : null}

      {revisionEditorNodeId && onReviseRun ? <WorkflowRevisionDialog nodeId={revisionEditorNodeId} definition={definition} onRevise={onReviseRun} onClose={() => setRevisionEditorNodeId(undefined)} /> : null}
      {draftEditorOpen && onUpdateDefinition ? <WorkflowDraftEditorDialog definition={definition} configuredAgents={configuredAgents} onSave={onUpdateDefinition} onClose={() => setDraftEditorOpen(false)} /> : null}

      {openNodeGraphNode ? <WorkflowNodeSurface
        node={openNodeGraphNode}
        editable={canEditDefinition}
        onUpdateNode={(update) => source.onUpdateNode(openNodeGraphNode.id, update)}
        {...(openNodeConversation ? { conversation: openNodeConversation } : {})}
        {...(openNodeTask ? { task: openNodeTask } : {})}
        sessions={nodeAgentSessions}
        {...(openNodeId ? { selectedNodeId: openNodeId } : {})}
        {...(openNodeProgress ? { progress: openNodeProgress } : {})}
        {...(onSubmitScriptInput && openNodeId ? { onSubmitScriptInput: (values: Record<string, unknown>) => onSubmitScriptInput(openNodeId, values) } : {})}
        {...(onResolveIntervention && openNodeId ? { onResolveScriptApproval: (action: "approve_once" | "reject") => onResolveIntervention(openNodeId, action) } : {})}
        onSelectNode={setOpenNodeId}
        onClose={() => { dismissedNodeSurfaceRunIdRef.current = activeRunId; setOpenNodeId(undefined); }}
        {...(onSendNodeMessage && openNodeConversation ? { onSend: (message: string) => onSendNodeMessage(openNodeConversation.conversationId, message) } : {})}
        {...(onCompleteNodeConversation && openNodeConversation ? { onConfirm: () => onCompleteNodeConversation(openNodeConversation.conversationId) } : {})}
        {...(onRejectNodeCompletion && openNodeConversation ? { onReject: (instruction: string) => onRejectNodeCompletion(openNodeConversation.conversationId, instruction) } : {})}
        {...(onInterruptNodeConversation && openNodeConversation ? { onInterrupt: () => onInterruptNodeConversation(openNodeConversation.conversationId) } : {})}
        {...(source.onResolveRuntimeApproval ? { onResolveRuntimeApproval: source.onResolveRuntimeApproval } : {})}
      /> : null}

      {!runOwnsInput && !topologyLocked ? <section className="composer workflow-composer">
        <div className="composer-box">
          <textarea
            aria-label={workflowStarted ? (graphVisible ? workflowText.replyToAgent : workflowText.replyToQuestion) : workflowText.task}
            value={composerValue}
            onChange={(event) => {
              if (workflowStarted) onReplyChange(event.currentTarget.value);
              else onObjectiveChange(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (shouldSendComposerKey({
                key: event.key,
                shiftKey: event.shiftKey,
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                isComposing: event.nativeEvent.isComposing,
              })) {
                event.preventDefault();
                if (composerCanSend) void onSendReply();
              }
            }}
            placeholder={composerPlaceholder}
            rows={2}
          />
          <div className="composer-footer">
            <ChatControls
              configuredAgentId={configuredAgentId}
              modelId={modelId}
              configuredAgents={configuredAgents}
              channels={channels}
              locked={composerLocked}
              running={running}
              workDir={workDir}
              runtimes={runtimes}
              onSelectConfiguredAgent={onSelectConfiguredAgent}
              onSelectModel={onSelectModel}
              onChooseWorkDir={onChooseWorkDir}
            />
            <div className="workflow-composer-actions">
              {!graphVisible && grillComplete ? (
                <button className="control-btn compact secondary" onClick={onBuildDefinition} disabled={running}>
                  <Wand2 size={14} />
                  <span>Generate Graph</span>
                </button>
              ) : null}
              <button className="send-btn" onClick={onSendReply} disabled={!composerCanSend}>
                <Send size={14} />
                <span>{running ? "Running" : workflowStarted ? "Send" : "Start"}</span>
              </button>
            </div>
          </div>
        </div>
        <div className="composer-hint">
          <kbd>↵</kbd> 发送 · <kbd>⇧↵</kbd> 换行 · {graphVisible ? "继续对话可修改 workflow" : "先对话生成 workflow"}
        </div>
      </section> : null}
    </>
  );
}
