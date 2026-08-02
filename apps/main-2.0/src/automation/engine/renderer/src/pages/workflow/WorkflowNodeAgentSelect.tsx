import type { ConfiguredAgent } from "../../../../shared/types";
import { useEffect, useRef, useState } from "react";

export function WorkflowNodeAgentSelect(props: {
  nodeTitle: string;
  configuredAgentId?: string;
  configuredAgents: ConfiguredAgent[];
  onSelect: (configuredAgentId: string | undefined) => void | Promise<void>;
}) {
  const [pendingValue, setPendingValue] = useState<string | undefined>(undefined);
  const requestRef = useRef(0);
  const selectedValue = pendingValue ?? props.configuredAgentId ?? "";
  useEffect(() => {
    if (pendingValue !== undefined && pendingValue !== "" && pendingValue === (props.configuredAgentId ?? "")) setPendingValue(undefined);
  }, [pendingValue, props.configuredAgentId]);
  return <select
    className="workflow-node-agent-select nodrag nopan"
    aria-label={`Agent for ${props.nodeTitle}`}
    value={selectedValue}
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.stopPropagation()}
    onChange={(event) => {
      event.stopPropagation();
      const next = event.currentTarget.value || undefined;
      const request = ++requestRef.current;
      setPendingValue(event.currentTarget.value);
      Promise.resolve(props.onSelect(next)).catch(() => {
        if (request === requestRef.current) setPendingValue(undefined);
      });
    }}
  >
    <option value="" disabled>Select Agent</option>
    {props.configuredAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.modelId}</option>)}
  </select>;
}
