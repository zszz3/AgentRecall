import { useState } from "react";
import { X } from "lucide-react";
import type { ConfiguredAgent, WorkflowV2Definition } from "../../../../shared/types";
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

export function WorkflowDraftEditorDialog(props: {
  definition: WorkflowV2Definition;
  configuredAgents: ConfiguredAgent[];
  onSave: (definition: WorkflowV2Definition) => void | Promise<void>;
  onClose: () => void;
}) {
  const [definitionJson, setDefinitionJson] = useState(() => JSON.stringify(props.definition, null, 2));
  const [error, setError] = useState<string | undefined>();
  let parsedDefinition: WorkflowV2Definition | undefined;
  try { parsedDefinition = JSON.parse(definitionJson) as WorkflowV2Definition; } catch { parsedDefinition = undefined; }

  function selectAgent(nodeId: string, configuredAgentId: string): void {
    if (!parsedDefinition) return;
    setDefinitionJson(JSON.stringify(updateWorkflowNodeAgentSelection(parsedDefinition, nodeId, configuredAgentId), null, 2));
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
        {parsedDefinition.nodes.filter((node) => node.execModel === "llm").map((node) => <label key={node.id}><span>{node.title}</span><select aria-label={`Agent for ${node.title}`} value={node.execModel === "llm" ? node.configuredAgentId ?? "" : ""} onChange={(event) => selectAgent(node.id, event.currentTarget.value)}><option value="">Workflow default</option>{props.configuredAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.modelId}</option>)}</select></label>)}
      </div> : null}
      <label>Workflow definition<textarea aria-label="Workflow definition JSON" value={definitionJson} onChange={(event) => setDefinitionJson(event.currentTarget.value)} spellCheck={false} /></label>
      {error ? <div className="workflow-error">{error}</div> : null}
      <footer><button className="control-btn" onClick={props.onClose}>Cancel</button><button className="send-btn" onClick={() => void save()}>Validate &amp; save new revision</button></footer>
    </section>
  </div>;
}
