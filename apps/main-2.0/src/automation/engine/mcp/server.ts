import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUNTIME_IDS } from "../shared/runtime-catalog";
import {
  STUDIO_MCP_TOOL_NAMES,
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
  studio_list_members: "/mcp/studio/list-members",
  studio_get_context: "/mcp/studio/get-context",
  studio_get_room_state: "/mcp/studio/get-room-state",
  studio_inbox_list: "/mcp/studio/inbox/list",
  studio_task_finish: "/mcp/studio/task/finish",
  studio_turn_list: "/mcp/studio/turn/list",
  studio_turn_get: "/mcp/studio/turn/get",
  studio_turn_events: "/mcp/studio/turn/events",
  studio_read_thread: "/mcp/studio/read-thread",
  studio_post: "/mcp/studio/post",
  studio_read_messages: "/mcp/studio/read-messages",
  studio_read_range: "/mcp/studio/read-range",
  studio_search: "/mcp/studio/search",
  workspace_reserve: "/mcp/workspace/reserve",
  workspace_release: "/mcp/workspace/release",
  workspace_status: "/mcp/workspace/status",
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
  "agent_templates_list",
  "skill_templates_list",
  "agents_list",
  "channels_list",
  "models_list",
  "workflow_list",
  "workflow_get",
  "workflow_validate",
  "workflow_run_list",
  "workflow_run_get",
  "workflow_outputs_list",
]);

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
      description: "Write an editable workflow DAG into the planning draft identified by workflowId. This never creates another top-level Workflow and does not confirm or publish the draft. Invalid graphs are rejected. Use interactive LLM nodes only to collect or clarify user input, and use script nodes for deterministic work such as echoing, copying, formatting, mapping, or passing values through unchanged. Governed script nodes must declare script.effectMode, script.idempotency, and script.stderrPolicy; strict_atomic brokered_external nodes must also use an available declarative Broker adapter and declare script.compensationAdapter. Strict scripts cannot declare unbrokered network capabilities. The current HTTP Broker does not expose response bodies as script outputs, so web research that feeds a downstream node must use an LLM research node with available web tools.",
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
      description: "Submit the current bound Workflow revision's final adversarial review. Call this exactly once after completing the review. Workflow identity and revision are injected by the managed Review session and cannot be selected by the model.",
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
      description: "Submit the current bound Runtime Review Gate result. Call this exactly once after assessing every configured dimension. Workflow, Run, Gate, node, candidate, and Reviewer identity are injected by the managed session.",
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
    {
      name: "workflow_confirm",
      description: "Confirm one exact workflow revision after validation.",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
      }, ["workflowId", "expectedRevision"]),
    },
    {
      name: "workflow_run",
      description: "Start a confirmed workflow revision and return its runId.",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        contextDocument: { type: "string" },
      }, ["workflowId", "expectedRevision"]),
    },
    {
      name: "workflow_run_list",
      description: "List workflow runs with optional workflow and status filters.",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        status: { type: "string", enum: ["draft", "running", "waiting_for_user", "completed", "failed", "stopped"] },
        startedAfter: { type: "number", minimum: 0 },
        startedBefore: { type: "number", minimum: 0 },
      }),
    },
    {
      name: "workflow_run_get",
      description: "Get one workflow run, node states, pending actions, and output summary.",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        runId: { type: "string" },
      }, ["workflowId", "runId"]),
    },
    {
      name: "workflow_stop",
      description: "Stop one exact workflow run without affecting other runs.",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        runId: { type: "string" },
      }, ["workflowId", "runId"]),
    },
    {
      name: "workflow_intervention_resolve",
      description: "Resolve the current intervention for one workflow node. Script approvals remain enforced.",
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
      description: "Submit structured values requested by one script node.",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        runId: { type: "string" },
        nodeId: { type: "string" },
        values: { type: "object", additionalProperties: true },
      }, ["workflowId", "runId", "nodeId", "values"]),
    },
    {
      name: "workflow_outputs_list",
      description: "List safe output metadata for one workflow run without exposing local absolute paths.",
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        runId: { type: "string" },
      }, ["workflowId", "runId"]),
    },
  ];
  const studioScoped = Boolean(process.env.AGENT_RECALL_STUDIO_TOKEN);
  if (studioScoped) {
    tools.push(
      {
        name: "studio_list_members",
        description: "List employees in the current AgentRecall studio and their current availability.",
        inputSchema: objectSchema({}),
      },
      {
        name: "studio_get_context",
        description: "Read the bounded room delta for the current Turn through its immutable trigger snapshot.",
        inputSchema: objectSchema({
          limit: { type: "integer", minimum: 1, maximum: 100 },
        }),
      },
      {
        name: "studio_get_room_state",
        description: "Read current-room metadata, the current Task, and latest room sequence.",
        inputSchema: objectSchema({}),
      },
      {
        name: "studio_inbox_list",
        description: "List mentions and Turn delivery states for the current studio employee.",
        inputSchema: objectSchema({
          status: {
            type: "string",
            enum: ["queued", "running", "completed", "failed", "interrupted", "skipped"],
          },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        }),
      },
      {
        name: "studio_task_finish",
        description: "Declare the current Task completed, blocked, or waiting for user input. Repeating the identical result is safe.",
        inputSchema: objectSchema({
          taskId: { type: "string" },
          status: {
            type: "string",
            enum: ["completed", "blocked", "waiting_input"],
          },
          summary: { type: "string", minLength: 1 },
          evidence: {
            type: "array",
            maxItems: 20,
            items: { type: "string" },
          },
        }, ["status", "summary"]),
      },
      {
        name: "studio_turn_list",
        description: "List logical Turns and sanitized Attempt summaries in the current room.",
        inputSchema: objectSchema({
          limit: { type: "integer", minimum: 1, maximum: 50 },
        }),
      },
      {
        name: "studio_turn_get",
        description: "Read one logical Turn and sanitized Attempt summaries in the current room.",
        inputSchema: objectSchema({
          turnId: { type: "string", minLength: 1 },
        }, ["turnId"]),
      },
      {
        name: "studio_turn_events",
        description: "Read bounded sanitized execution events for one Turn in the current room.",
        inputSchema: objectSchema({
          turnId: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        }, ["turnId"]),
      },
      {
        name: "studio_read_thread",
        description: "Read public messages belonging to one root message thread in the current room.",
        inputSchema: objectSchema({
          rootMessageId: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        }, ["rootMessageId"]),
      },
      {
        name: "studio_post",
        description: "Post visible studio information without activating another employee.",
        inputSchema: objectSchema({
          content: { type: "string", minLength: 1 },
          replyTo: { type: "string" },
        }, ["content"]),
      },
      {
        name: "studio_read_messages",
        description: "Read specific messages from the current studio by ID.",
        inputSchema: objectSchema({
          messageIds: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
        }, ["messageIds"]),
      },
      {
        name: "studio_read_range",
        description: "Read a bounded sequence range from the current studio timeline.",
        inputSchema: objectSchema({
          after: { type: "integer", minimum: 0 },
          before: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        }),
      },
      {
        name: "studio_search",
        description: "Search visible messages in the current studio.",
        inputSchema: objectSchema({
          query: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        }, ["query"]),
      },
      {
        name: "workspace_reserve",
        description: "Declare relative project paths that this employee intends to modify.",
        inputSchema: objectSchema({
          paths: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
          reason: { type: "string" },
        }, ["paths"]),
      },
      {
        name: "workspace_release",
        description: "Release relative project paths reserved by this employee.",
        inputSchema: objectSchema({
          paths: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
        }, ["paths"]),
      },
      {
        name: "workspace_status",
        description: "List active path reservations in the current studio.",
        inputSchema: objectSchema({
          paths: { type: "array", maxItems: 50, items: { type: "string" } },
        }),
      },
    );
  }
  const managed = Boolean(process.env.AGENT_RECALL_WORKFLOW_MCP_TOKEN);
  if (managed && process.env.AGENT_RECALL_WORKFLOW_RUN_ID && process.env.AGENT_RECALL_WORKFLOW_NODE_ID && process.env.AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID) {
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
        proposals: { type: "array", items: workflowProposalSchema },
      }, ["nodeId", "summary", "outputs", "proposals"]),
    });
  }
  const allowed = new Set(
    managed
      ? workflowMcpToolsForScope(workflowMcpScopeFromEnvironment(process.env))
      : READ_ONLY_TOOL_NAMES,
  );
  if (studioScoped) {
    for (const toolName of STUDIO_MCP_TOOL_NAMES) allowed.add(toolName);
  }
  return tools
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => READ_ONLY_TOOL_NAMES.has(tool.name)
      ? { ...tool, annotations: { readOnlyHint: true } }
      : tool);
}

export function resolveBridgeDiscoveryPath(): string {
  if (process.env.AGENT_RECALL_MCP_BRIDGE) return process.env.AGENT_RECALL_MCP_BRIDGE;
  if (process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE) return process.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "AgentRecall", "mcp-bridge.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "AgentRecall", "mcp-bridge.json");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-recall-v2", "mcp-bridge.json");
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
      ...(process.env.AGENT_RECALL_STUDIO_TOKEN
        ? { "x-agent-recall-studio-token": process.env.AGENT_RECALL_STUDIO_TOKEN }
        : {}),
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
          serverInfo: { name: "agent-recall-v2", version: "0.1.0" },
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
