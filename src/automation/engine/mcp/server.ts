import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNTIME_IDS } from "../shared/runtime-catalog";

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

const TOOL_ROUTES: Record<string, string> = {
  agent_templates_list: "/mcp/agent-templates/list",
  skill_templates_list: "/mcp/skill-templates/list",
  agents_list: "/mcp/agents/list",
  agents_create: "/mcp/agents/create",
  agents_update: "/mcp/agents/update",
  agents_delete: "/mcp/agents/delete",
  agents_test: "/mcp/agents/test",
  channels_list: "/mcp/channels/list",
  models_list: "/mcp/models/list",
  workflow_create: "/mcp/workflow/create",
  workflow_list: "/mcp/workflow/list",
  workflow_get: "/mcp/workflow/get",
  workflow_update: "/mcp/workflow/update",
  workflow_validate: "/mcp/workflow/validate",
  workflow_context_append: "/mcp/workflow/context/append",
  workflow_run_context_append: "/mcp/workflow/run-context/append",
  workflow_node_complete: "/mcp/workflow/node/complete",
};

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

const workflowV2DefinitionSchema = {
  type: "object",
  properties: {
    workflowId: { type: "string" },
    graphVersion: { type: "integer", minimum: 1 },
    objective: { type: "string" },
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, kind: { type: "string" }, title: { type: "string" },
          execModel: { type: "string", enum: ["llm", "script"] },
          executionMode: { type: "string", enum: ["one-shot", "interactive", "script"] },
          executionModeRationale: { type: "string" }, executionModeConfidence: { type: "number", minimum: 0, maximum: 1 },
          role: { type: "string", enum: ["orchestrator", "executor", "reviewer"] },
          modelProfile: { type: "string", enum: ["fast", "balanced", "expert"] }, prompt: { type: "string" },
          outputFields: { type: "array", items: objectSchema({ key: { type: "string" }, required: { type: "boolean" }, description: { type: "string" } }, ["key"]) },
          script: { type: "object", additionalProperties: true },
        },
        required: ["id", "kind", "title", "execModel", "executionMode", "outputFields"],
        additionalProperties: true,
      },
    },
    edges: { type: "array", items: objectSchema({ fromNodeId: { type: "string" }, toNodeId: { type: "string" } }, ["fromNodeId", "toNodeId"]) },
  },
  required: ["workflowId", "graphVersion", "objective", "nodes", "edges"],
  additionalProperties: false,
};

const artifactsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["text", "file", "url"] },
      title: { type: "string" },
      content: { type: "string" },
      path: { type: "string" },
      url: { type: "string" },
    },
    required: ["kind", "title"],
    additionalProperties: false,
  },
};

export function mcpToolDefinitions(): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [
    {
      name: "agent_templates_list",
      description: "Compatibility alias for skill_templates_list.",
      inputSchema: objectSchema({}),
    },
    {
      name: "skill_templates_list",
      description: "List built-in skill templates. Templates contain skill metadata, tags, source, and original SKILL.md prompt. Runtime, provider, and model remain user configuration.",
      inputSchema: objectSchema({}),
    },
    {
      name: "agents_list",
      description: "List configured agents and their runtime/channel/model selections.",
      inputSchema: objectSchema({}),
    },
    {
      name: "agents_create",
      description: "Create a configured agent. Use skill_templates_list first when you want to seed an agent prompt from a skill.",
      inputSchema: objectSchema(
        {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          runtimeAgentId: { type: "string", enum: RUNTIME_IDS },
          channelId: { type: "string" },
          modelId: { type: "string" },
          prompt: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          templateId: { type: "string" },
        },
        ["id", "name"],
      ),
    },
    {
      name: "agents_update",
      description: "Update an existing configured agent. Omitted fields keep their current values.",
      inputSchema: objectSchema(
        {
          agentId: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          runtimeAgentId: { type: "string", enum: RUNTIME_IDS },
          channelId: { type: "string" },
          modelId: { type: "string" },
          prompt: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          templateId: { type: "string" },
        },
        ["agentId"],
      ),
    },
    {
      name: "agents_delete",
      description: "Delete a configured agent by id. This does not delete workflow graphs that reference it.",
      inputSchema: objectSchema({ agentId: { type: "string" } }, ["agentId"]),
    },
    {
      name: "agents_test",
      description: "Run the same connectivity smoke test as the desktop UI for a configured agent.",
      inputSchema: objectSchema({ agentId: { type: "string" } }, ["agentId"]),
    },
    {
      name: "channels_list",
      description: "List available runtime provider channels. Secrets and HTTP authorization headers are not returned.",
      inputSchema: objectSchema({ agentId: { type: "string", enum: RUNTIME_IDS } }),
    },
    {
      name: "models_list",
      description: "List models available on channels, optionally filtered by channelId or agent runtime.",
      inputSchema: objectSchema({
        agentId: { type: "string", enum: RUNTIME_IDS },
        channelId: { type: "string" },
      }),
    },
    {
      name: "workflow_create",
      description: "Write an editable workflow DAG into the planning draft identified by workflowId. This never creates another top-level Workflow and does not confirm or publish the draft. Invalid graphs are rejected. Use interactive LLM nodes only to collect or clarify user input, and use script nodes for deterministic work such as echoing, copying, formatting, mapping, or passing values through unchanged.",
      inputSchema: objectSchema(
        {
          workflowId: { type: "string" },
          title: { type: "string" },
          objective: { type: "string" },
          definition: workflowV2DefinitionSchema,
          agentId: { type: "string", enum: RUNTIME_IDS },
          channelId: { type: "string" },
          modelId: { type: "string" },
        },
        ["workflowId", "title", "objective", "definition"],
      ),
    },
    {
      name: "workflow_list",
      description: "List workflow summaries in AgentRecall.",
      inputSchema: objectSchema({}),
    },
    {
      name: "workflow_get",
      description: "Get a workflow by workflowId, including graph, status, revision, and context.",
      inputSchema: objectSchema({ workflowId: { type: "string" } }, ["workflowId"]),
    },
    {
      name: "workflow_update",
      description: "Update the editable planning draft identified by workflowId. This does not confirm or publish the draft.",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        expectedRevision: { type: "number" },
        title: { type: "string" },
        objective: { type: "string" },
        definition: workflowV2DefinitionSchema,
      }, ["workflowId"]),
    },
    {
      name: "workflow_validate",
      description: "Validate a workflow graph or an existing workflowId without modifying state.",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        definition: workflowV2DefinitionSchema,
      }),
    },
    {
      name: "workflow_context_append",
      description: "Append long-lived context to a workflow. File and URL artifacts are stored as references only.",
      inputSchema: objectSchema(
        {
          workflowId: { type: "string" },
          report: { type: "string" },
          handoff: { type: "string" },
          artifacts: artifactsSchema,
        },
        ["workflowId", "report", "handoff"],
      ),
    },
    {
      name: "workflow_run_context_append",
      description: "Append context to one running workflow run. This does not modify graph structure.",
      inputSchema: objectSchema(
        {
          workflowId: { type: "string" },
          runId: { type: "string" },
          nodeId: { type: "string" },
          report: { type: "string" },
          handoff: { type: "string" },
          artifacts: artifactsSchema,
        },
        ["workflowId", "runId", "report", "handoff"],
      ),
    },
  ];
  if (process.env.AGENT_RECALL_WORKFLOW_RUN_ID && process.env.AGENT_RECALL_WORKFLOW_NODE_ID) {
    tools.push({
      name: "workflow_node_complete",
      description: "Submit the current workflow node's validated structured result. Call this exactly once when the node is complete; ordinary text remains conversation history.",
      inputSchema: objectSchema({
        nodeId: { type: "string", const: process.env.AGENT_RECALL_WORKFLOW_NODE_ID },
        summary: { type: "string", minLength: 1 },
        outputs: { type: "object", additionalProperties: true },
        evidence: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
        nextStepSuggestions: { type: "array", items: { type: "string" } },
        proposals: { type: "array" },
      }, ["nodeId", "summary", "outputs", "proposals"]),
    });
  }
  return tools;
}

export function resolveBridgeDiscoveryPath(): string {
  if (process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE) return process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "AgentRecall", "mcp-bridge.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "AgentRecall", "mcp-bridge.json");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-recall", "mcp-bridge.json");
}

async function readBridgeDiscovery(): Promise<{ host: string; port: number; token: string }> {
  const discoveryPath = resolveBridgeDiscoveryPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(discoveryPath, "utf8")) as unknown;
  } catch {
    throw new Error("AgentRecall is not running. Open the desktop app first, then retry this tool call.");
  }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  if (typeof record.host !== "string" || typeof record.port !== "number" || typeof record.token !== "string") {
    throw new Error("AgentRecall MCP bridge discovery file is invalid.");
  }
  return { host: record.host, port: record.port, token: record.token };
}

export async function callMcpTool(name: string, args: unknown): Promise<unknown> {
  const route = TOOL_ROUTES[name];
  if (!route) throw new Error(`Unknown MCP tool: ${name}`);
  const discovery = await readBridgeDiscovery();
  const response = await fetch(`http://${discovery.host}:${discovery.port}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${discovery.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...(args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {}),
      ...(name === "workflow_node_complete" ? {
        workflowId: process.env.AGENT_RECALL_WORKFLOW_ID,
        runId: process.env.AGENT_RECALL_WORKFLOW_RUN_ID,
      } : {}),
    }),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) throw new Error(`MCP bridge request failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function writeJsonRpc(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handleJsonRpc(request: JsonRpcRequest): Promise<void> {
  if (request.id === undefined) return;
  try {
    if (request.method === "initialize") {
      writeJsonRpc({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-recall", version: "0.1.0" },
        },
      });
      return;
    }
    if (request.method === "tools/list") {
      writeJsonRpc({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: mcpToolDefinitions() },
      });
      return;
    }
    if (request.method === "tools/call") {
      const params = request.params && typeof request.params === "object" ? (request.params as Record<string, unknown>) : {};
      const name = typeof params.name === "string" ? params.name : "";
      const result = await callMcpTool(name, params.arguments ?? {});
      const ok = Boolean(result && typeof result === "object" && "ok" in result ? (result as { ok?: unknown }).ok : true);
      writeJsonRpc({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !ok,
        },
      });
      return;
    }
    writeJsonRpc({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unknown method: ${request.method}` } });
  } catch (error) {
    writeJsonRpc({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function startStdioMcpServer(): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      void handleJsonRpc(JSON.parse(line) as JsonRpcRequest);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStdioMcpServer();
}
