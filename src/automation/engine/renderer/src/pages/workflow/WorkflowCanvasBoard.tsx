import { createContext, useCallback, useContext, useEffect, useMemo, type ReactElement } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type Edge as ReactFlowEdge,
  type Node as ReactFlowNode,
  type NodeProps as ReactFlowNodeProps,
} from "@xyflow/react";
import type { WorkflowRunProgressItem } from "../../../../shared/types";
import type { WorkflowV2Definition, WorkflowV2Node } from "../../../../shared/workflow-v2/definition";
import { workflowCanvasLayout, type WorkflowCanvasLayoutVariant } from "./workflow-canvas-layout";

type WorkflowFlowNodeData = { node: WorkflowV2Node; layerSize: number };
type WorkflowFlowNode = ReactFlowNode<WorkflowFlowNodeData, "workflowNode">;
type WorkflowFlowEdge = ReactFlowEdge<Record<string, never>, "smoothstep">;

const workflowFlowNodeTypes = { workflowNode: WorkflowFlowNodeCard };
const WorkflowCanvasNodeContext = createContext<{
  renderNodeCard: (node: WorkflowV2Node) => ReactElement;
  runProgressByNodeId: Map<string, WorkflowRunProgressItem>;
}>({ renderNodeCard: () => <span />, runProgressByNodeId: new Map<string, WorkflowRunProgressItem>() });

function WorkflowFlowNodeCard({ data }: ReactFlowNodeProps<WorkflowFlowNode>) {
  const { node, layerSize } = data;
  const { renderNodeCard, runProgressByNodeId } = useContext(WorkflowCanvasNodeContext);
  const runProgress = runProgressByNodeId.get(node.id);
  return (
    <div className={`workflow-canvas-node is-${node.execModel} ${runProgress ? `run-${runProgress.status}` : ""}`} data-layer-size={layerSize}>
      <Handle type="target" position={Position.Left} className="workflow-canvas-handle" isConnectable={false} />
      {renderNodeCard(node)}
      <Handle type="source" position={Position.Right} className="workflow-canvas-handle" isConnectable={false} />
    </div>
  );
}

function workflowLayoutFlowNodes(definition: WorkflowV2Definition, variant: WorkflowCanvasLayoutVariant): WorkflowFlowNode[] {
  return workflowCanvasLayout(definition, variant).nodes.map((layoutNode) => ({
    id: layoutNode.node.id,
    type: "workflowNode",
    position: { x: layoutNode.x, y: layoutNode.y },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: { node: layoutNode.node, layerSize: layoutNode.layerSize },
    style: { width: layoutNode.width, minHeight: layoutNode.height },
  }));
}

function workflowFlowEdges(definition: WorkflowV2Definition, variant: WorkflowCanvasLayoutVariant, runProgressByNodeId: Map<string, WorkflowRunProgressItem>): WorkflowFlowEdge[] {
  return workflowCanvasLayout(definition, variant).edges.map(({ edge }) => ({
    id: `${edge.fromNodeId}->${edge.toNodeId}`,
    type: "smoothstep",
    source: edge.fromNodeId,
    target: edge.toNodeId,
    animated: runProgressByNodeId.get(edge.fromNodeId)?.status === "running" || runProgressByNodeId.get(edge.toNodeId)?.status === "running",
    selectable: false,
    data: {},
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    style: { strokeWidth: 2 },
  }));
}

function workflowMiniMapNodeColor(node: WorkflowFlowNode, runProgress?: WorkflowRunProgressItem): string {
  if (runProgress?.status === "failed") return "var(--danger)";
  if (runProgress?.status === "completed") return "var(--ok)";
  if (runProgress?.status === "running") return "var(--accent)";
  return node.data.node.execModel === "script" ? "var(--warning)" : "var(--accent)";
}

export function WorkflowCanvasBoard({
  definition,
  expanded = false,
  runProgressByNodeId = new Map<string, WorkflowRunProgressItem>(),
  onExpand,
  onOpenNode,
  renderNodeCard,
  className = "",
}: {
  definition: WorkflowV2Definition;
  expanded?: boolean;
  runProgressByNodeId?: Map<string, WorkflowRunProgressItem>;
  onExpand?: () => void;
  onOpenNode?: (nodeId: string) => void;
  renderNodeCard: (node: WorkflowV2Node) => ReactElement;
  className?: string;
}) {
  const variant: WorkflowCanvasLayoutVariant = expanded ? "expanded" : "preview";
  const layoutNodes = useMemo(() => workflowLayoutFlowNodes(definition, variant), [definition, variant]);
  const edges = useMemo(() => workflowFlowEdges(definition, variant, runProgressByNodeId), [definition, variant, runProgressByNodeId]);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowFlowNode>(layoutNodes);
  useEffect(() => setNodes(layoutNodes), [layoutNodes, setNodes]);
  const nodeContextValue = useMemo(() => ({ renderNodeCard, runProgressByNodeId }), [renderNodeCard, runProgressByNodeId]);
  const miniMapNodeColor = useCallback((node: WorkflowFlowNode) => workflowMiniMapNodeColor(node, runProgressByNodeId.get(node.id)), [runProgressByNodeId]);
  const fitViewOptions = useMemo(() => ({ padding: expanded ? 0.16 : 0.12, minZoom: expanded ? 0.24 : 0.82, maxZoom: expanded ? 1.05 : 1 }), [expanded]);
  return (
    <div className={`workflow-canvas-board workflow-graph-board ${className} ${expanded ? "is-expanded" : ""}`} aria-label="Workflow graph board" onDoubleClick={() => onExpand?.()}>
      <div className="workflow-canvas-viewport">
        <WorkflowCanvasNodeContext.Provider value={nodeContextValue}>
          <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
            className="workflow-react-flow-board" nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={workflowFlowNodeTypes}
            fitView fitViewOptions={fitViewOptions} minZoom={expanded ? 0.18 : 0.32} maxZoom={expanded ? 1.35 : 1.28}
            panOnDrag panOnScroll zoomOnScroll={expanded} zoomOnPinch zoomOnDoubleClick={false}
            onNodeClick={(_event, node) => onOpenNode?.(node.id)}
            nodesConnectable={false} nodesDraggable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false}
            preventScrolling={expanded} proOptions={{ hideAttribution: true }} defaultEdgeOptions={{ type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } }}
          >
            <Background gap={18} size={1.25} color="var(--workflow-canvas-dot)" />
            <Controls className="workflow-canvas-controls" position="bottom-left" fitViewOptions={fitViewOptions} showInteractive={false} />
            <MiniMap className="workflow-canvas-minimap" position="bottom-right" pannable zoomable nodeColor={miniMapNodeColor} nodeBorderRadius={8} bgColor="var(--panel)" maskColor="color-mix(in srgb, var(--panel) 42%, transparent)" />
          </ReactFlow>
        </WorkflowCanvasNodeContext.Provider>
      </div>
    </div>
  );
}
