import type { ConfiguredAgent } from "../../../../shared/types";

export function WorkflowNodeAgentSelect(props: {
  nodeTitle: string;
  configuredAgentId?: string;
  workflowDefaultAgentId: string;
  configuredAgents: ConfiguredAgent[];
  onSelect: (configuredAgentId: string | undefined) => void;
}) {
  const workflowDefault = props.configuredAgents.find((agent) => agent.id === props.workflowDefaultAgentId);
  return <select
    className="workflow-node-agent-select"
    aria-label={`Agent for ${props.nodeTitle}`}
    value={props.configuredAgentId ?? ""}
    onClick={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.stopPropagation()}
    onChange={(event) => { event.stopPropagation(); props.onSelect(event.currentTarget.value || undefined); }}
  >
    <option value="">Workflow default · {workflowDefault?.name ?? props.workflowDefaultAgentId}</option>
    {props.configuredAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.modelId}</option>)}
  </select>;
}
