import type { WorkflowV2Definition, WorkflowV2Edge, WorkflowV2Node } from "../../../../shared/workflow-v2/definition";

export interface WorkflowCanvasNodeLayout {
  node: WorkflowV2Node;
  x: number;
  y: number;
  width: number;
  height: number;
  layerIndex: number;
  layerSize: number;
}

export interface WorkflowCanvasEdgeLayout {
  edge: WorkflowV2Edge;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface WorkflowCanvasLayout {
  nodes: WorkflowCanvasNodeLayout[];
  edges: WorkflowCanvasEdgeLayout[];
  width: number;
  height: number;
}

export type WorkflowCanvasLayoutVariant = "preview" | "expanded";

const WORKFLOW_CANVAS_DIMENSIONS: Record<WorkflowCanvasLayoutVariant, {
  nodeWidth: number;
  nodeHeight: number;
  layerGap: number;
  nodeGap: number;
  rowGap: number;
  padding: number;
  maxColumns: number;
}> = {
  preview: { nodeWidth: 192, nodeHeight: 72, layerGap: 46, nodeGap: 16, rowGap: 78, padding: 28, maxColumns: 4 },
  expanded: { nodeWidth: 188, nodeHeight: 112, layerGap: 120, nodeGap: 30, rowGap: 128, padding: 88, maxColumns: 5 },
};

function workflowV2DisplayLayers(definition: WorkflowV2Definition): WorkflowV2Node[][] {
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const indegree = new Map(definition.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of definition.edges) {
    if (!nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId)) continue;
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
    outgoing.get(edge.fromNodeId)?.push(edge.toNodeId);
  }
  const layers: WorkflowV2Node[][] = [];
  let ready = definition.nodes.filter((node) => indegree.get(node.id) === 0);
  const visited = new Set<string>();
  while (ready.length > 0) {
    const layer = ready.filter((node) => !visited.has(node.id));
    if (layer.length === 0) break;
    layer.forEach((node) => visited.add(node.id));
    layers.push(layer);
    const nextIds: string[] = [];
    for (const node of layer) {
      for (const targetId of outgoing.get(node.id) ?? []) {
        const next = (indegree.get(targetId) ?? 0) - 1;
        indegree.set(targetId, next);
        if (next === 0) nextIds.push(targetId);
      }
    }
    ready = nextIds.map((id) => nodeById.get(id)).filter((node): node is WorkflowV2Node => Boolean(node));
  }
  const unvisited = definition.nodes.filter((node) => !visited.has(node.id));
  return unvisited.length > 0 ? [...layers, unvisited] : layers;
}

export function workflowCanvasLayout(definition: WorkflowV2Definition, variant: WorkflowCanvasLayoutVariant = "preview"): WorkflowCanvasLayout {
  const dimensions = WORKFLOW_CANVAS_DIMENSIONS[variant];
  const layers = workflowV2DisplayLayers(definition).filter((layer) => layer.length > 0);
  const rowCount = Math.max(1, Math.ceil(layers.length / dimensions.maxColumns));
  const columnsPerRow = Math.max(1, Math.ceil(layers.length / rowCount));
  const layerHeight = (layer: WorkflowV2Node[]) => layer.length * dimensions.nodeHeight + Math.max(0, layer.length - 1) * dimensions.nodeGap;
  const rows: WorkflowV2Node[][][] = [];
  for (let index = 0; index < layers.length; index += columnsPerRow) rows.push(layers.slice(index, index + columnsPerRow));

  const positionedNodes = new Map<string, WorkflowCanvasNodeLayout>();
  let maxX = dimensions.padding;
  let maxY = dimensions.padding;
  let rowTop = dimensions.padding;
  rows.forEach((row, rowIndex) => {
    const rowHeight = Math.max(dimensions.nodeHeight, ...row.map(layerHeight));
    row.forEach((layer, columnIndex) => {
      const x = dimensions.padding + columnIndex * (dimensions.nodeWidth + dimensions.layerGap);
      let y = rowTop + Math.max(0, (rowHeight - layerHeight(layer)) / 2);
      layer.forEach((node) => {
        positionedNodes.set(node.id, { node, x, y, width: dimensions.nodeWidth, height: dimensions.nodeHeight, layerIndex: rowIndex * columnsPerRow + columnIndex, layerSize: layer.length });
        maxX = Math.max(maxX, x + dimensions.nodeWidth + dimensions.padding);
        maxY = Math.max(maxY, y + dimensions.nodeHeight + dimensions.padding);
        y += dimensions.nodeHeight + dimensions.nodeGap;
      });
    });
    rowTop += rowHeight + dimensions.rowGap;
  });
  const edges = definition.edges.map((edge) => {
    const fromNode = positionedNodes.get(edge.fromNodeId);
    const toNode = positionedNodes.get(edge.toNodeId);
    if (!fromNode || !toNode) return undefined;
    return { edge, from: { x: fromNode.x + fromNode.width, y: fromNode.y + fromNode.height / 2 }, to: { x: toNode.x, y: toNode.y + toNode.height / 2 } };
  }).filter((item): item is WorkflowCanvasEdgeLayout => Boolean(item));
  return { nodes: [...positionedNodes.values()], edges, width: Math.max(maxX, dimensions.padding * 2 + dimensions.nodeWidth), height: Math.max(maxY, dimensions.padding * 2 + dimensions.nodeHeight) };
}
