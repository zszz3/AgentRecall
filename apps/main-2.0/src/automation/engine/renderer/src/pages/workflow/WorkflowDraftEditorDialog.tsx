import { useDeferredValue, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { ConfiguredAgent, WorkflowV2Definition } from "../../../../shared/types";
import type { WorkflowV2ReviewGate } from "../../../../shared/workflow-v2/definition";
import { validateWorkflowV2Definition } from "../../../../shared/workflow-v2/validation";

export function updateWorkflowNodeAgentSelection(definition: WorkflowV2Definition, nodeId: string, configuredAgentId: string): WorkflowV2Definition {
  const next = structuredClone(definition);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.execModel !== "llm") return next;
  if (configuredAgentId) node.configuredAgentId = configuredAgentId;
  else delete node.configuredAgentId;
  delete node.modelId;
  return next;
}

export function addWorkflowReviewGate(definition: WorkflowV2Definition, nodeId: string, configuredAgentId: string): WorkflowV2Definition {
  const next = structuredClone(definition);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.execModel !== "llm" || node.role === "reviewer") return next;
  if (next.reviewGates?.some((gate) => gate.targetNodeId === nodeId)) return next;
  const gateIds = new Set((next.reviewGates ?? []).map((gate) => gate.id));
  let id = `review-${nodeId}`;
  for (let suffix = 2; gateIds.has(id); suffix += 1) id = `review-${nodeId}-${suffix}`;
  next.reviewGates = [...(next.reviewGates ?? []), {
    id,
    targetNodeId: nodeId,
    configuredAgentId,
    reviewLevel: "medium",
    judgeDimensions: [{ key: "quality", description: "结果满足节点目标、约束和输出契约。" }],
    maxQualityRetries: 2,
  }];
  return next;
}

export function updateWorkflowReviewGate(definition: WorkflowV2Definition, gateId: string, update: (gate: WorkflowV2ReviewGate) => void): WorkflowV2Definition {
  const next = structuredClone(definition);
  const gate = next.reviewGates?.find((candidate) => candidate.id === gateId);
  if (gate) update(gate);
  return next;
}

export function removeWorkflowReviewGate(definition: WorkflowV2Definition, gateId: string): WorkflowV2Definition {
  const next = structuredClone(definition);
  next.reviewGates = (next.reviewGates ?? []).filter((gate) => gate.id !== gateId);
  return next;
}

export function WorkflowDraftEditorDialog(props: {
  definition: WorkflowV2Definition;
  configuredAgents: ConfiguredAgent[];
  runtimeReviewEnabled: boolean;
  onSave: (definition: WorkflowV2Definition) => void | Promise<void>;
  onClose: () => void;
}) {
  const [definitionJson, setDefinitionJson] = useState(() => JSON.stringify(props.definition, null, 2));
  const [error, setError] = useState<string | undefined>();
  const deferredDefinitionJson = useDeferredValue(definitionJson);
  const parsingPending = deferredDefinitionJson !== definitionJson;
  const parsedDefinition = useMemo(() => {
    try { return JSON.parse(deferredDefinitionJson) as WorkflowV2Definition; } catch { return undefined; }
  }, [deferredDefinitionJson]);

  function selectAgent(nodeId: string, configuredAgentId: string): void {
    if (!parsedDefinition) return;
    setDefinitionJson(JSON.stringify(updateWorkflowNodeAgentSelection(parsedDefinition, nodeId, configuredAgentId), null, 2));
  }

  function replaceDefinition(next: WorkflowV2Definition): void {
    setDefinitionJson(JSON.stringify(next, null, 2));
    setError(undefined);
  }

  async function save(): Promise<void> {
    try {
      const definition = JSON.parse(definitionJson) as WorkflowV2Definition;
      const validation = validateWorkflowV2Definition(definition);
      if (!validation.valid) throw new Error(validation.errors.join("\n"));
      await props.onSave(definition);
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <div className="workflow-revision-backdrop" role="presentation" onClick={props.onClose}>
    <section className="workflow-revision-dialog" role="dialog" aria-modal="true" aria-label="Edit workflow definition" onClick={(event) => event.stopPropagation()}>
      <header><div><strong>Edit workflow definition</strong><span>Saving creates a new draft revision. Previous runs keep their original graph version.</span></div><button className="icon-btn" onClick={props.onClose} aria-label="Close workflow editor"><X size={15} /></button></header>
      {parsedDefinition?.nodes.some((node) => node.execModel === "llm") ? <div className="workflow-node-agent-config-list">
        {parsedDefinition.nodes.filter((node) => node.execModel === "llm").map((node) => <label key={node.id}><span>{node.title}</span><select aria-label={`Agent for ${node.title}`} value={node.execModel === "llm" ? node.configuredAgentId ?? "" : ""} disabled={parsingPending} onChange={(event) => selectAgent(node.id, event.currentTarget.value)}><option value="" disabled>Select Agent</option>{props.configuredAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.modelId}</option>)}</select></label>)}
      </div> : null}
      {props.runtimeReviewEnabled && parsedDefinition ? <section className="workflow-review-gate-editor" aria-label="Runtime Review Gates">
        <header><div><strong>Runtime Review Gates</strong><span>Each Agent node can have one independently configured, read-only review.</span></div></header>
        {parsedDefinition.nodes.filter((node) => node.execModel === "llm" && node.role !== "reviewer").map((node) => {
          const gate = parsedDefinition.reviewGates?.find((candidate) => candidate.targetNodeId === node.id);
          if (!gate) return <div className="workflow-review-gate-target" key={node.id}><span><strong>{node.title}</strong><small>No Review Gate</small></span><button className="icon-btn" title="Add Review Gate" aria-label={`Add Review Gate for ${node.title}`} disabled={parsingPending} onClick={() => replaceDefinition(addWorkflowReviewGate(parsedDefinition, node.id, props.configuredAgents[0]?.id ?? ""))}><Plus size={15} /></button></div>;
          return <div className="workflow-review-gate-config" key={gate.id}>
            <div className="workflow-review-gate-config-title"><span><strong>{node.title}</strong><small>{gate.id}</small></span><button className="icon-btn" title="Remove Review Gate" aria-label={`Remove Review Gate for ${node.title}`} onClick={() => replaceDefinition(removeWorkflowReviewGate(parsedDefinition, gate.id))}><Trash2 size={15} /></button></div>
            <div className="workflow-review-gate-grid">
              <label><span>Review Agent</span><select value={gate.configuredAgentId} onChange={(event) => replaceDefinition(updateWorkflowReviewGate(parsedDefinition, gate.id, (current) => { current.configuredAgentId = event.currentTarget.value; }))}><option value="" disabled>Select Agent</option>{props.configuredAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.modelId}</option>)}</select></label>
              <label><span>Required quality</span><select value={gate.reviewLevel} onChange={(event) => replaceDefinition(updateWorkflowReviewGate(parsedDefinition, gate.id, (current) => { current.reviewLevel = event.currentTarget.value as WorkflowV2ReviewGate["reviewLevel"]; }))}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
              <label><span>Quality retries</span><input type="number" min={0} max={5} value={gate.maxQualityRetries} onChange={(event) => replaceDefinition(updateWorkflowReviewGate(parsedDefinition, gate.id, (current) => { current.maxQualityRetries = Math.max(0, Math.min(5, Number(event.currentTarget.value) || 0)); }))} /></label>
            </div>
            <div className="workflow-review-dimensions"><div><strong>Review dimensions</strong><button className="icon-btn" title="Add review dimension" aria-label={`Add review dimension for ${node.title}`} onClick={() => replaceDefinition(updateWorkflowReviewGate(parsedDefinition, gate.id, (current) => { let suffix = current.judgeDimensions.length + 1; const keys = new Set(current.judgeDimensions.map((item) => item.key)); while (keys.has(`dimension-${suffix}`)) suffix += 1; current.judgeDimensions.push({ key: `dimension-${suffix}`, description: "" }); }))}><Plus size={14} /></button></div>{gate.judgeDimensions.map((dimension, index) => <div className="workflow-review-dimension-row" key={`${gate.id}:${index}`}><input aria-label={`Dimension key ${index + 1}`} value={dimension.key} onChange={(event) => replaceDefinition(updateWorkflowReviewGate(parsedDefinition, gate.id, (current) => { current.judgeDimensions[index]!.key = event.currentTarget.value; }))} /><input aria-label={`Dimension description ${index + 1}`} value={dimension.description} onChange={(event) => replaceDefinition(updateWorkflowReviewGate(parsedDefinition, gate.id, (current) => { current.judgeDimensions[index]!.description = event.currentTarget.value; }))} /><button className="icon-btn" title="Remove review dimension" aria-label={`Remove review dimension ${index + 1}`} disabled={gate.judgeDimensions.length === 1} onClick={() => replaceDefinition(updateWorkflowReviewGate(parsedDefinition, gate.id, (current) => { current.judgeDimensions.splice(index, 1); }))}><Trash2 size={14} /></button></div>)}</div>
          </div>;
        })}
      </section> : null}
      <label>Workflow definition<textarea aria-label="Workflow definition JSON" value={definitionJson} onChange={(event) => { setDefinitionJson(event.currentTarget.value); setError(undefined); }} spellCheck={false} /></label>
      {error ? <div className="workflow-error">{error}</div> : null}
      <footer><button className="control-btn" onClick={props.onClose}>Cancel</button><button className="send-btn" onClick={() => void save()}>Validate &amp; save new revision</button></footer>
    </section>
  </div>;
}
