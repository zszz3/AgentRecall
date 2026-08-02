import type {
  AgentChannel,
  ConfiguredAgent,
  McpServerDefinition,
  WorkflowDraftState,
  WorkflowPortableFileV1,
  WorkflowReadinessIssue,
  WorkflowReadinessResult,
} from "../../../shared/types";
import { isModelForChannel } from "../../../shared/models";

type ReadinessWorkflow = Pick<WorkflowDraftState, "configuredAgentId" | "modelId" | "reviewerConfiguredAgentId" | "reviewerModelId" | "definition">;

export function inspectWorkflowReadiness(input: {
  workflow: ReadinessWorkflow;
  configuredAgents: Iterable<ConfiguredAgent>;
  channels: AgentChannel[];
  mcpServers: McpServerDefinition[];
}): WorkflowReadinessResult {
  const agents = new Map([...input.configuredAgents].map((agent) => [agent.id, agent]));
  const issues: WorkflowReadinessIssue[] = [];
  inspectRoute({ scope: "reviewer", field: "reviewerConfiguredAgentId", configuredAgentId: input.workflow.reviewerConfiguredAgentId, modelId: input.workflow.reviewerModelId });

  for (const node of input.workflow.definition.nodes) {
    if (node.execModel === "llm") {
      const configuredAgentId = node.configuredAgentId?.trim() ?? "";
      if (!configuredAgentId) {
        issues.push({ code: "AGENT_MISSING", scope: "node", nodeId: node.id, field: "configuredAgentId", configuredAgentId, message: `Node ${node.title} requires an Agent from Runtime.` });
        continue;
      }
      const agent = agents.get(configuredAgentId);
      const modelId = node.modelId || agent?.modelId || "default";
      inspectRoute({ scope: "node", nodeId: node.id, field: "configuredAgentId", configuredAgentId, modelId });
      if (agent) {
        const tools = availableTools(agent, input.mcpServers);
        for (const requiredTool of node.requiredTools ?? []) {
          if (!tools.has(requiredTool)) {
            issues.push({ code: "REQUIRED_TOOL_MISSING", scope: "node", nodeId: node.id, field: "requiredTools", configuredAgentId, message: `Node ${node.title} requires unavailable tool ${requiredTool}.` });
          }
        }
      }
      continue;
    }
    for (const parameter of node.script.parameters) {
      if (parameter.valueType === "secret" && parameter.required && parameter.source === "literal" && parameter.literalValue === undefined && parameter.defaultValue === undefined) {
        issues.push({ code: "SECRET_VALUE_REQUIRED", scope: "node", nodeId: node.id, field: `script.parameters.${parameter.key}`, message: `Node ${node.title} requires secret parameter ${parameter.label} to be configured.` });
      }
    }
  }
  return { ready: issues.length === 0, issues };

  function inspectRoute(route: Omit<WorkflowReadinessIssue, "code" | "message"> & { configuredAgentId: string; modelId: string }): void {
    const agent = agents.get(route.configuredAgentId);
    if (!agent) {
      issues.push({ ...route, code: "AGENT_MISSING", message: `Configured Agent ${route.configuredAgentId} is unavailable.` });
      return;
    }
    if (!isModelForChannel(agent.runtimeAgentId, agent.channelId, route.modelId, input.channels)) {
      issues.push({ ...route, code: "MODEL_UNAVAILABLE", message: `Model ${route.modelId} is unavailable for Agent ${route.configuredAgentId}.` });
    }
  }
}

export function portableWorkflowReadiness(file: WorkflowPortableFileV1, catalogs: Omit<Parameters<typeof inspectWorkflowReadiness>[0], "workflow">): WorkflowReadinessResult {
  return inspectWorkflowReadiness({
    ...catalogs,
    workflow: {
      configuredAgentId: file.workflow.executionDefaults.configuredAgentId,
      modelId: file.workflow.executionDefaults.modelId,
      reviewerConfiguredAgentId: file.workflow.executionDefaults.reviewerConfiguredAgentId,
      reviewerModelId: file.workflow.executionDefaults.reviewerModelId,
      definition: file.workflow.definition,
    },
  });
}

function availableTools(agent: ConfiguredAgent, servers: McpServerDefinition[]): Set<string> {
  const serverById = new Map(servers.filter((server) => server.enabled).map((server) => [server.id, server]));
  const tools = new Set<string>();
  for (const binding of agent.mcpBindings ?? []) {
    const server = serverById.get(binding.serverId);
    if (!server) continue;
    const declared = new Set(server.tools.map((tool) => tool.name));
    const enabled = binding.toolAllowlist.length > 0 ? binding.toolAllowlist : declared;
    for (const name of enabled) if (declared.has(name)) tools.add(name);
  }
  return tools;
}
