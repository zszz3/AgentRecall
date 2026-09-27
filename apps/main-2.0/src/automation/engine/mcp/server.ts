import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUNTIME_IDS } from "../shared/runtime-catalog";
import {
  workflowMcpScopeFromEnvironment,
  workflowMcpToolsForScope,
} from "../shared/workflow-mcp-policy";

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

const TOOL_ROUTES: Record<string, string> = {
  search_tools: "/mcp/gateway/tools/search",
  get_tool: "/mcp/gateway/tools/get",
  call_tool: "/mcp/gateway/tools/call",
  list_skills: "/mcp/gateway/skills/list",
  get_skill: "/mcp/gateway/skills/get",
  search_sessions: "/mcp/gateway/sessions/search",
  get_session: "/mcp/gateway/sessions/get",
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
  workflow_review_submit: "/mcp/workflow/review/submit",
  workflow_review_gate_submit: "/mcp/workflow/review-gate/submit",
  workflow_list: "/mcp/workflow/list",
  workflow_get: "/mcp/workflow/get",
  workflow_update: "/mcp/workflow/update",
  workflow_validate: "/mcp/workflow/validate",
  workflow_confirm: "/mcp/workflow/confirm",
  workflow_run: "/mcp/workflow/run",
  workflow_run_list: "/mcp/workflow/run/list",
  workflow_run_get: "/mcp/workflow/run/get",
  workflow_stop: "/mcp/workflow/run/stop",
  workflow_intervention_resolve: "/mcp/workflow/intervention/resolve",
  workflow_script_input_submit: "/mcp/workflow/script-input/submit",
  workflow_outputs_list: "/mcp/workflow/outputs/list",
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

const workflowV2ScriptValueSchema = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
  ],
};

const workflowV2ScriptSchema = objectSchema({
  executable: {
    oneOf: [
      objectSchema({ kind: { type: "string", enum: ["inline"] }, language: { type: "string", enum: ["python", "typescript", "bash"] }, code: { type: "string" } }, ["kind", "language", "code"]),
      objectSchema({ kind: { type: "string", enum: ["command"] }, command: { type: "string" }, args: { type: "array", items: { type: "string" } } }, ["kind", "command"]),
    ],
  },
  parameters: {
    type: "array",
    items: objectSchema({
      key: { type: "string" },
      label: { type: "string" },
      location: { type: "string", enum: ["argument", "environment", "header", "query", "body", "stdin"] },
      valueType: { type: "string", enum: ["string", "number", "boolean", "json", "secret", "file", "directory"] },
      source: { type: "string", enum: ["user", "workflow", "upstream", "literal"] },
      required: { type: "boolean" },
      description: { type: "string" },
      enum: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } },
      defaultValue: workflowV2ScriptValueSchema,
      workflowPath: { type: "string" },
      upstreamNodeId: { type: "string" },
      upstreamOutputKey: { type: "string" },
      literalValue: workflowV2ScriptValueSchema,
    }, ["key", "label", "location", "valueType", "source", "required"]),
  },
  capabilities: {
    type: "array",
    items: { type: "string", enum: ["workspace_read", "workspace_write", "workspace_delete", "external_read", "external_write", "external_delete", "network_read", "network_write", "process_spawn", "shell_execute", "environment_read", "credential_read", "system_config_write"] },
  },
  managerRisk: objectSchema({ level: { type: "string", enum: ["safe", "read", "write", "dangerous"] }, rationale: { type: "string" } }, ["level", "rationale"]),
  effectMode: { type: "string", enum: ["pure", "workspace_only", "brokered_external"] },
  idempotency: { type: "string", enum: ["safe_retry", "keyed", "non_idempotent"] },
  stderrPolicy: { type: "string", enum: ["ignore", "warn", "fail"] },
  compensationAdapter: { type: "string" },
  timeoutMs: { type: "integer", minimum: 1 },
  outputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["object"] },
      required: { type: "array", items: { type: "string" } },
      properties: { type: "object", additionalProperties: true },
    },
    required: ["type"],
    additionalProperties: false,
  },
}, ["executable", "parameters", "capabilities", "managerRisk", "effectMode", "idempotency", "stderrPolicy"]);

const workflowTransactionPolicySchema = objectSchema({
  defaultMode: { type: "string", enum: ["strict_atomic", "controlled", "direct"] },
  approvalMode: { type: "string", enum: ["batch", "per_operation", "user_choice"] },
  checkpoints: {
    type: "array",
    items: objectSchema({
      id: { type: "string" },
      title: { type: "string" },
      afterNodeIds: { type: "array", items: { type: "string" } },
      kind: { type: "string", enum: ["savepoint", "commit"] },
      approval: { type: "string", enum: ["automatic", "required"] },
    }, ["id", "title", "afterNodeIds", "kind", "approval"]),
  },
  retentionDays: { type: "integer", minimum: 1 },
  onUnknown: { type: "string", enum: ["pause"] },
  onConflict: { type: "string", enum: ["user_or_manager"] },
}, ["defaultMode", "approvalMode", "checkpoints", "retentionDays", "onUnknown", "onConflict"]);

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
          script: workflowV2ScriptSchema,
        },
        required: ["id", "kind", "title", "execModel", "executionMode", "outputFields"],
        additionalProperties: true,
      },
    },
    edges: { type: "array", items: objectSchema({ fromNodeId: { type: "string" }, toNodeId: { type: "string" } }, ["fromNodeId", "toNodeId"]) },
    reviewGates: {
      type: "array",
      items: objectSchema({
        id: { type: "string", minLength: 1 },
        targetNodeId: { type: "string", minLength: 1 },
        configuredAgentId: { type: "string", minLength: 1 },
        reviewLevel: { type: "string", enum: ["low", "medium", "high"] },
        judgeDimensions: { type: "array", minItems: 1, items: objectSchema({ key: { type: "string", minLength: 1 }, description: { type: "string", minLength: 1 } }, ["key", "description"]) },
        maxQualityRetries: { type: "integer", minimum: 0, maximum: 5 },
      }, ["id", "targetNodeId", "configuredAgentId", "reviewLevel", "judgeDimensions", "maxQualityRetries"]),
    },
    transactionPolicy: workflowTransactionPolicySchema,
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

const workflowProposalSchema = {
  oneOf: [
    objectSchema({
      kind: { type: "string", const: "continue" },
      reason: { type: "string", minLength: 1 },
      targetNodeIds: { type: "array", items: { type: "string", minLength: 1 } },
    }, ["kind", "reason"]),
    objectSchema({
      kind: { type: "string", const: "retry" },
      reason: { type: "string", minLength: 1 },
      targetNodeId: { type: "string", minLength: 1 },
    }, ["kind", "reason"]),
    objectSchema({
      kind: { type: "string", const: "escalate" },
      reason: { type: "string", minLength: 1 },
    }, ["kind", "reason"]),
    objectSchema({
      kind: { type: "string", const: "graph-revision" },
      reason: { type: "string", minLength: 1 },
    }, ["kind", "reason"]),
  ],
};

const READ_ONLY_TOOL_NAMES = new Set([
  "workflow_list",
  "workflow_get",
  "workflow_validate",
  "workflow_run_list",
  "workflow_run_get",
  "workflow_outputs_list",
]);

function gatewayToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "search_tools",
      description: "分页浏览 AgentRecall 中已开放的索引工具。可通过 sourceId 只查看某个内置或第三方 MCP 工具源；结果仅包含简要索引，完整参数请调用 get_tool。",
      inputSchema: objectSchema({
        sourceId: { type: "string", description: "可选的工具源 ID；省略时浏览全部已开放索引工具。" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        cursor: { type: "string", description: "上一页返回的 nextCursor。" },
      }),
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_tool",
      description: "根据 search_tools 返回的 toolRef 读取一个工具的完整说明和输入参数 Schema。",
      inputSchema: objectSchema({ toolRef: { type: "string", minLength: 1 } }, ["toolRef"]),
      annotations: { readOnlyHint: true },
    },
    {
      name: "call_tool",
      description: "调用已通过 AgentRecall MCP 页面启用的索引工具。先用 search_tools 获取 toolRef，再用 get_tool 查看参数。",
      inputSchema: objectSchema({
        toolRef: { type: "string", minLength: 1 },
        arguments: { type: "object", additionalProperties: true },
      }, ["toolRef"]),
    },
    {
      name: "list_skills",
      description: "列出 AgentRecall 已管理的 Skill 简要索引；需要完整说明时再调用 get_skill。",
      inputSchema: objectSchema({}),
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_skill",
      description: "根据 list_skills 返回的 managedId 读取一个 Skill 的完整 Markdown 说明。",
      inputSchema: objectSchema({ managedId: { type: "string", minLength: 1 } }, ["managedId"]),
      annotations: { readOnlyHint: true },
    },
    {
      name: "search_sessions",
      description: "搜索 AgentRecall 已索引的编码 Agent 会话，返回简要结果和 sessionKey；需要完整上下文时再调用 get_session。",
      inputSchema: objectSchema({
        query: { type: "string" },
        source: { type: "string" },
        project: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      }),
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_session",
      description: "根据 search_sessions 返回的 sessionKey 分页读取会话内容。",
      inputSchema: objectSchema({
        sessionKey: { type: "string", minLength: 1 },
        maxMessages: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      }, ["sessionKey"]),
      annotations: { readOnlyHint: true },
    },
  ];
}

export function mcpToolDefinitions(): McpToolDefinition[] {
  const managed = Boolean(process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN);
  if (process.env.AGENT_RECALL_MCP_MODE === "gateway") return gatewayToolDefinitions();
  const tools: McpToolDefinition[] = [
    {
      name: "agent_templates_list",
      description: "skill_templates_list 的兼容别名。",
      inputSchema: objectSchema({}),
    },
    {
      name: "skill_templates_list",
      description: "列出内置 Skill 模板。模板包含 Skill 元数据、标签、来源和原始 SKILL.md 提示词；运行时、服务商和模型仍由用户配置。",
      inputSchema: objectSchema({}),
    },
    {
      name: "agents_list",
      description: "列出已配置的 Agent 及其运行时、通道和模型选择。",
      inputSchema: objectSchema({}),
    },
    {
      name: "agents_create",
      description: "创建一个已配置的 Agent；如需用 Skill 初始化 Agent 提示词，请先调用 skill_templates_list。",
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
      description: "更新现有 Agent；省略的字段保持不变。",
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
      description: "按 ID 删除 Agent；不会删除引用它的 Workflow 图。",
      inputSchema: objectSchema({ agentId: { type: "string" } }, ["agentId"]),
    },
    {
      name: "agents_test",
      description: "对指定 Agent 执行与桌面端相同的连接冒烟测试。",
      inputSchema: objectSchema({ agentId: { type: "string" } }, ["agentId"]),
    },
    {
      name: "channels_list",
      description: "列出可用的运行时服务通道；不会返回密钥或 HTTP 鉴权请求头。",
      inputSchema: objectSchema({ agentId: { type: "string", enum: RUNTIME_IDS } }),
    },
    {
      name: "models_list",
      description: "列出通道可用模型，可按 channelId 或 Agent 运行时筛选。",
      inputSchema: objectSchema({
        agentId: { type: "string", enum: RUNTIME_IDS },
        channelId: { type: "string" },
      }),
    },
    {
      name: "workflow_create",
      description: "把可编辑的 Workflow DAG 写入 workflowId 指定的规划草稿；不会创建另一个顶层 Workflow，也不会确认或发布草稿。无效图会被拒绝。交互式 LLM 节点仅用于收集或澄清用户输入；回显、复制、格式化、映射或原样传值等确定性工作应使用脚本节点。受治理脚本节点必须声明 script.effectMode、script.idempotency 和 script.stderrPolicy；strict_atomic 模式下的 brokered_external 节点还必须使用可用的声明式 Broker 适配器并声明 script.compensationAdapter。严格模式脚本不得声明未经 Broker 管理的网络能力。当前 HTTP Broker 不提供响应正文作为脚本输出，因此需要把网页研究结果传给下游节点时，必须使用具备网页工具的 LLM 研究节点。",
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
      name: "workflow_review_submit",
      description: "提交当前绑定 Workflow 修订版的最终对抗性审核。完成审核后只能调用一次；Workflow 标识和修订版由托管审核会话注入，模型无法自行选择。",
      inputSchema: objectSchema({
        verdict: { type: "string", enum: ["approve", "revise"] },
        summary: { type: "string", minLength: 1 },
        findings: {
          type: "array",
          items: objectSchema({
            severity: { type: "string", enum: ["blocking", "warning"] },
            nodeIds: { type: "array", items: { type: "string", minLength: 1 } },
            summary: { type: "string", minLength: 1 },
            failurePath: { type: "string", minLength: 1 },
            requiredChange: { type: "string", minLength: 1 },
          }, ["severity", "nodeIds", "summary", "failurePath", "requiredChange"]),
        },
        scriptRisks: {
          type: "object",
          additionalProperties: objectSchema({
            level: { type: "string", enum: ["safe", "read", "write", "dangerous"] },
            rationale: { type: "string", minLength: 1 },
          }, ["level", "rationale"]),
        },
        suggestions: { type: "array", items: { type: "string", minLength: 1 } },
      }, ["verdict", "summary", "findings", "scriptRisks", "suggestions"]),
    },
    {
      name: "workflow_review_gate_submit",
      description: "提交当前绑定的运行时审核门禁结果。评估完所有配置维度后只能调用一次；Workflow、运行、门禁、节点、候选结果和审核者标识均由托管会话注入。",
      inputSchema: objectSchema({
        reasons: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        requiredFixes: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        riskLevel: { type: "string", enum: ["low", "medium", "high"] },
        evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        dimensionResults: {
          type: "array",
          minItems: 1,
          items: objectSchema({
            key: { type: "string", minLength: 1 },
            qualityLevel: { type: "string", enum: ["low", "medium", "high"] },
            reason: { type: "string", minLength: 1 },
            evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          }, ["key", "qualityLevel", "reason", "evidence"]),
        },
      }, ["reasons", "riskLevel", "confidence", "dimensionResults"]),
    },
    {
      name: "workflow_list",
      description: "列出 AgentRecall 中的 Workflow 摘要。",
      inputSchema: objectSchema({}),
    },
    {
      name: "workflow_get",
      description: "按 workflowId 获取 Workflow，包括图、状态、修订版和上下文。",
      inputSchema: objectSchema({ workflowId: { type: "string" } }, ["workflowId"]),
    },
    {
      name: "workflow_update",
      description: "更新 workflowId 指定的可编辑规划草稿；不会确认或发布草稿。",
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
      description: "校验 Workflow 图或已有 workflowId，不修改任何状态。",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        definition: workflowV2DefinitionSchema,
      }),
    },
    {
      name: "workflow_context_append",
      description: "向 Workflow 追加长期上下文；文件和 URL 产物只保存引用。",
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
      description: "向一个正在运行的 Workflow 实例追加上下文；不会修改图结构。",
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
    {
      name: "workflow_confirm",
      description: "校验通过后确认一个精确的 Workflow 修订版。",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
      }, ["workflowId", "expectedRevision"]),
    },
    {
      name: "workflow_run",
      description: "启动一个已确认的 Workflow 修订版并返回 runId。",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        contextDocument: { type: "string" },
      }, ["workflowId", "expectedRevision"]),
    },
    {
      name: "workflow_run_list",
      description: "列出 Workflow 运行记录，可按 Workflow 和状态筛选。",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        status: { type: "string", enum: ["draft", "running", "waiting_for_user", "completed", "failed", "stopped"] },
        startedAfter: { type: "number", minimum: 0 },
        startedBefore: { type: "number", minimum: 0 },
      }),
    },
    {
      name: "workflow_run_get",
      description: "获取一次 Workflow 运行及其节点状态、待处理操作和输出摘要。",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        runId: { type: "string" },
      }, ["workflowId", "runId"]),
    },
    {
      name: "workflow_stop",
      description: "停止一次精确指定的 Workflow 运行，不影响其他运行。",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        runId: { type: "string" },
      }, ["workflowId", "runId"]),
    },
    {
      name: "workflow_intervention_resolve",
      description: "处理一个 Workflow 节点当前的人工干预；脚本审批仍会强制执行。",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        runId: { type: "string" },
        nodeId: { type: "string" },
        action: { type: "string", enum: ["continue", "skip", "escalate", "replan", "increase_review_strength", "approve_once", "reject"] },
        reason: { type: "string" },
      }, ["workflowId", "runId", "nodeId", "action"]),
    },
    {
      name: "workflow_script_input_submit",
      description: "提交一个脚本节点请求的结构化值。",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        runId: { type: "string" },
        nodeId: { type: "string" },
        values: { type: "object", additionalProperties: true },
      }, ["workflowId", "runId", "nodeId", "values"]),
    },
    {
      name: "workflow_outputs_list",
      description: "列出一次 Workflow 运行的安全输出元数据，不暴露本地绝对路径。",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        runId: { type: "string" },
      }, ["workflowId", "runId"]),
    },
  ];
  if (managed && process.env.AGENT_RECALL_WORKFLOW_RUN_ID && process.env.AGENT_RECALL_WORKFLOW_NODE_ID && process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID) {
    tools.push({
      name: "workflow_node_complete",
      description: "提交当前 Workflow 节点已经校验的结构化结果。节点完成时只能调用一次；普通文本仍保留在对话历史中。",
      inputSchema: objectSchema({
        nodeId: { type: "string", const: process.env.AGENT_RECALL_WORKFLOW_NODE_ID },
        summary: { type: "string", minLength: 1 },
        outputs: { type: "object", additionalProperties: true },
        evidence: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
        nextStepSuggestions: { type: "array", items: { type: "string" } },
        proposals: { type: "array", items: workflowProposalSchema },
      }, ["nodeId", "summary", "outputs", "proposals"]),
    });
  }
  const allowed = new Set(
    managed
      ? workflowMcpToolsForScope(workflowMcpScopeFromEnvironment(process.env))
      : READ_ONLY_TOOL_NAMES,
  );
  return tools
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => READ_ONLY_TOOL_NAMES.has(tool.name)
      ? { ...tool, annotations: { readOnlyHint: true } }
      : tool);
}

export function resolveBridgeDiscoveryPath(): string {
  if (process.env.AGENT_RECALL_MCP_BRIDGE) return process.env.AGENT_RECALL_MCP_BRIDGE;
  if (process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE) return process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "agent-recall-v2", "automation-mcp-bridge.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "agent-recall-v2", "automation-mcp-bridge.json");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-recall-v2", "automation-mcp-bridge.json");
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
  return {
    host: record.host,
    port: record.port,
    token: process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN || record.token,
  };
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
        executionId: process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID,
      } : name === "workflow_review_submit" ? {
        workflowId: process.env.AGENT_RECALL_WORKFLOW_ID,
        reviewedRevision: Number(process.env.AGENT_RECALL_WORKFLOW_REVIEW_REVISION),
      } : name === "workflow_review_gate_submit" ? {
        workflowId: process.env.AGENT_RECALL_WORKFLOW_ID,
        runId: process.env.AGENT_RECALL_WORKFLOW_RUN_ID,
        executionId: process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID,
      } : {}),
    }),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) throw new Error(`MCP bridge request failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

interface StdioServerLifecycle {
  beginRequest(): void;
  endRequest(): void;
  beginStdoutWrite(): (() => void) | null;
}

let activeStdioServer: StdioServerLifecycle | null = null;

function writeJsonRpc(payload: unknown): void {
  const line = `${JSON.stringify(payload)}\n`;
  // Pipe writes are asynchronous; only count a response as delivered once its
  // write callback fires, so shutdown never truncates the last response.
  const finishWrite = activeStdioServer?.beginStdoutWrite();
  if (finishWrite) process.stdout.write(line, finishWrite);
  else process.stdout.write(line);
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
          serverInfo: {
            name: process.env.AGENT_RECALL_MCP_MODE === "gateway" ? "agent-recall" : "agent-recall-v2",
            version: "0.1.0",
          },
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
      const resultRecord = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : undefined;
      const isError = resultRecord?.isError === true
        || Boolean(resultRecord && "ok" in resultRecord && !resultRecord.ok);
      writeJsonRpc({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError,
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

const STDIO_MCP_SHUTDOWN_DRAIN_MS = 5_000;

export interface StdioMcpServerOptions {
  stdin?: NodeJS.ReadableStream & { readableEnded: boolean; destroyed: boolean };
  stdout?: NodeJS.WritableStream;
  signalTarget?: { on(signal: NodeJS.Signals, listener: () => void): unknown };
  exit?: (code: number) => void;
  drainMs?: number;
}

function shutdownDrainMsFromEnvironment(): number {
  const raw = process.env.AGENT_RECALL_MCP_SHUTDOWN_DRAIN_MS?.trim();
  if (!raw) return STDIO_MCP_SHUTDOWN_DRAIN_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : STDIO_MCP_SHUTDOWN_DRAIN_MS;
}

export function startStdioMcpServer(options: StdioMcpServerOptions = {}): void {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const signalTarget = options.signalTarget ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const drainMs = options.drainMs ?? shutdownDrainMsFromEnvironment();
  let buffer = "";
  let inFlightRequests = 0;
  let pendingStdoutWrites = 0;
  let shutdownReason: string | null = null;
  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  const settle = () => {
    if (shutdownReason !== null && inFlightRequests <= 0 && pendingStdoutWrites <= 0) exitOnce(0);
  };
  const shutdown = (reason: string) => {
    if (shutdownReason !== null) return;
    shutdownReason = reason;
    if (inFlightRequests <= 0 && pendingStdoutWrites <= 0) {
      exitOnce(0);
      return;
    }
    // The host is already gone; give in-flight requests a bounded window to
    // flush their last responses, then stop instead of leaking the process.
    const drainTimer = setTimeout(() => exitOnce(0), drainMs);
    drainTimer.unref();
  };
  const lifecycle: StdioServerLifecycle = {
    beginRequest: () => {
      inFlightRequests += 1;
    },
    endRequest: () => {
      inFlightRequests -= 1;
      settle();
    },
    beginStdoutWrite: () => {
      pendingStdoutWrites += 1;
      return () => {
        pendingStdoutWrites -= 1;
        settle();
      };
    },
  };
  activeStdioServer = lifecycle;

  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    if (shutdownReason !== null) return;
    buffer += chunk;
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      lifecycle.beginRequest();
      void handleJsonRpc(JSON.parse(line) as JsonRpcRequest).finally(() => lifecycle.endRequest());
    }
  });
  // Hosts release stdio MCP servers by closing the pipes; without these
  // handlers the gateway/workflow entries outlive their client (issue #499).
  stdin.on("end", () => shutdown("stdin end"));
  stdin.on("close", () => shutdown("stdin close"));
  stdin.on("error", () => shutdown("stdin error"));
  stdout.on("error", () => shutdown("stdout error"));
  signalTarget.on("SIGTERM", () => shutdown("SIGTERM"));
  signalTarget.on("SIGINT", () => shutdown("SIGINT"));
  if (stdin.readableEnded || stdin.destroyed) shutdown("stdin already closed");
}
