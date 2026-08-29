import { createContext, useContext, useEffect, useMemo, useRef, type ReactElement } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Bot, CirclePause, Code2, ShieldCheck } from "lucide-react";
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeRunStatus,
  WorkflowRun,
} from "../../../../automation/engine/shared/workflow/model";
import { workflowConnections } from "./workflow-editor-model";
import { layoutWorkflowNodes, type WorkflowGraphPosition } from "./workflow-graph-layout";

interface WorkflowGraphNodeData extends Record<string, unknown> {
  workflowNode: WorkflowNode;
  executorLabel: string;
  runStatus?: WorkflowNodeRunStatus;
}

type WorkflowGraphNode = Node<WorkflowGraphNodeData, "workflowCore">;
type WorkflowGraphEdge = Edge<Record<string, never>, "smoothstep">;

const nodeIcons = { agent: Bot, script: Code2, review: ShieldCheck, approval: CirclePause };
const CanvasModeContext = createContext<"definition" | "run">("definition");

function WorkflowGraphNodeView({ data, selected }: NodeProps<WorkflowGraphNode>): ReactElement {
  const mode = useContext(CanvasModeContext);
  const node = data.workflowNode;
  const Icon = nodeIcons[node.kind];
  return <div className={`workflow-graph-node is-${node.kind} ${selected ? "is-selected" : ""} ${data.runStatus ? `run-${data.runStatus}` : ""}`}>
    <Handle type="target" position={Position.Left} className="workflow-graph-port" />
    <span className="workflow-graph-node-kind"><Icon size={12} /> {node.kind}</span>
    <strong>{node.title}</strong>
    <footer><span>{data.executorLabel}</span>{mode === "run" && data.runStatus ? <em>{data.runStatus}</em> : null}</footer>
    <Handle type="source" position={Position.Right} className="workflow-graph-port" />
  </div>;
}

const nodeTypes = { workflowCore: WorkflowGraphNodeView };

function graphNodes(definition: WorkflowDefinition, agentNames: ReadonlyMap<string, string>, run?: WorkflowRun, selectedNodeId?: string): WorkflowGraphNode[] {
  const positions = layoutWorkflowNodes(definition);
  return definition.nodes.map((workflowNode) => ({
    id: workflowNode.id,
    type: "workflowCore",
    position: positions[workflowNode.id]!,
    selected: workflowNode.id === selectedNodeId,
    data: {
      workflowNode,
      executorLabel: workflowNode.kind === "agent" || workflowNode.kind === "review"
        ? agentNames.get(workflowNode.agentId) ?? workflowNode.agentId
        : workflowNode.kind === "script"
          ? `${workflowNode.runtime === "typescript" ? "TypeScript" : workflowNode.runtime === "python" ? "Python" : "Bash"} Script`
          : "人工确认",
      ...(run?.nodeRuns[workflowNode.id]?.status ? { runStatus: run.nodeRuns[workflowNode.id]!.status } : {}),
    },
  }));
}

function graphEdges(definition: WorkflowDefinition, run?: WorkflowRun): WorkflowGraphEdge[] {
  return workflowConnections(definition).map((connection) => {
    const sourceStatus = run?.nodeRuns[connection.fromNodeId]?.status;
    const targetStatus = run?.nodeRuns[connection.toNodeId]?.status;
    return {
      id: `${connection.fromNodeId}:${connection.fromOutputKey}->${connection.toNodeId}`,
      type: "smoothstep",
      source: connection.fromNodeId,
      target: connection.toNodeId,
      label: definition.nodes.find((node) => node.id === connection.fromNodeId)?.outputs.find((output) => output.key === connection.fromOutputKey)?.name ?? connection.fromOutputKey,
      animated: sourceStatus === "running" || targetStatus === "running",
      selectable: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      className: targetStatus ? `run-${targetStatus}` : undefined,
      labelShowBg: true,
      labelBgPadding: [5, 3],
      labelBgBorderRadius: 5,
    };
  });
}

function miniMapColor(node: WorkflowGraphNode): string {
  if (node.data.runStatus === "failed") return "var(--danger)";
  if (node.data.runStatus === "completed") return "var(--ok)";
  if (node.data.runStatus === "running") return "var(--accent)";
  if (node.data.workflowNode.kind === "review") return "#3aa47d";
  if (node.data.workflowNode.kind === "script") return "#9b72cf";
  if (node.data.workflowNode.kind === "approval") return "#d6a342";
  return "#7785ef";
}

export function WorkflowGraphCanvas({
  definition,
  run,
  mode,
  agents,
  readOnly = false,
  selectedNodeId,
  onSelectNode,
  onPositionsChange,
}: {
  definition: WorkflowDefinition;
  run?: WorkflowRun;
  mode: "definition" | "run";
  agents: Array<{ id: string; name: string }>;
  readOnly?: boolean;
  selectedNodeId?: string;
  onSelectNode: (nodeId: string | undefined) => void;
  onPositionsChange: (positions: Record<string, WorkflowGraphPosition>) => void;
}): ReactElement {
  const visibleRun = mode === "run" ? run : undefined;
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const layoutNodes = useMemo(() => graphNodes(definition, agentNames, visibleRun, selectedNodeId), [agentNames, definition, visibleRun, selectedNodeId]);
  const edges = useMemo(() => graphEdges(definition, visibleRun), [definition, visibleRun]);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowGraphNode>(layoutNodes);
  const flow = useRef<ReactFlowInstance<WorkflowGraphNode, WorkflowGraphEdge> | undefined>(undefined);
  useEffect(() => setNodes(layoutNodes), [layoutNodes, setNodes]);
  // Run polling rebuilds layoutNodes on every snapshot. Without this guard the
  // viewport would be yanked back to the selected node each poll, even after
  // the user panned away.
  const lastCenteredNodeId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selectedNodeId) {
      lastCenteredNodeId.current = undefined;
      return;
    }
    if (!flow.current || lastCenteredNodeId.current === selectedNodeId) return;
    const selected = layoutNodes.find((node) => node.id === selectedNodeId);
    if (!selected) return;
    lastCenteredNodeId.current = selectedNodeId;
    void flow.current.setCenter(selected.position.x + 285, selected.position.y + 48, {
      zoom: Math.max(flow.current.getZoom(), 0.82),
      duration: 240,
    });
  }, [layoutNodes, selectedNodeId]);

  const organize = (): void => {
    const positions = layoutWorkflowNodes(definition, { force: true });
    setNodes((current) => current.map((node) => ({ ...node, position: positions[node.id] ?? node.position })));
    onPositionsChange(positions);
  };

  return <CanvasModeContext.Provider value={mode}>
    <ReactFlow<WorkflowGraphNode, WorkflowGraphEdge>
      className="workflow-core-react-flow"
      nodes={nodes}
      edges={edges}
      onInit={(instance) => { flow.current = instance; }}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_event, node) => onSelectNode(node.id)}
      onPaneClick={() => onSelectNode(undefined)}
      onNodeDragStop={(_event, node) => onPositionsChange({ [node.id]: { x: node.position.x, y: node.position.y } })}
      nodesConnectable={false}
      nodesDraggable={!readOnly}
      fitView
      fitViewOptions={{ padding: 0.25, minZoom: 0.45, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={1.6}
      panOnDrag
      panOnScroll
      zoomOnPinch
      zoomOnScroll
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: "smoothstep" }}
    >
      <Background gap={19} size={1.1} color="var(--workflow-core-dot)" />
      <Controls className="workflow-core-flow-controls" position="bottom-left" showInteractive={false} />
      {definition.nodes.length >= 4 ? <MiniMap className="workflow-core-minimap" position="bottom-right" pannable zoomable nodeColor={miniMapColor} nodeBorderRadius={8} /> : null}
      {!readOnly ? <Panel position="top-right"><button type="button" className="workflow-core-organize nodrag nopan" onClick={organize}>整理图</button></Panel> : null}
    </ReactFlow>
  </CanvasModeContext.Provider>;
}
