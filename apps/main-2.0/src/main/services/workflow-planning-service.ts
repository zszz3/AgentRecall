import { z } from "zod";
import type { WorkflowDefinition, WorkflowPlanningRequest, WorkflowPlanningState } from "../../automation/engine/shared/workflow/model";
import { validateWorkflowDefinition } from "../../automation/engine/shared/workflow/validation";
import type { ConfiguredAgentExecutionService } from "../../automation/engine/main/platform/configured-agent-execution-service";
import { parseWorkflowAgentOutputs } from "./workflow-core-service";

const text = z.string().max(50_000);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/u).max(200);
const field = z.object({
  key, name: text, description: text,
  type: z.enum(["text", "number", "boolean", "file", "object", "list"]), required: z.boolean(),
}).strict();
const base = {
  id: key, title: text, goal: text,
  inputs: z.array(z.discriminatedUnion("source", [
    z.object({ source: z.literal("workflow"), workflowInputKey: key }).strict(),
    z.object({ source: z.literal("node"), nodeId: key, outputKey: key }).strict(),
  ])).max(200),
  outputs: z.array(field).max(200), acceptanceCriteria: z.array(text).max(100),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
};
const agent = { agentId: z.string().min(1).max(200), instructions: z.array(text).max(100), constraints: z.array(text).max(100) };
const proposalSchema = z.object({
  name: text.min(1), description: text.min(1), inputs: z.array(field).max(200),
  nodes: z.array(z.discriminatedUnion("kind", [
    z.object({ ...base, ...agent, kind: z.literal("agent") }).strict(),
    z.object({ ...base, kind: z.literal("script"), runtime: z.enum(["bash", "python", "typescript"]), source: text,
      timeoutSeconds: z.number().int().min(1).max(3600),
      permissions: z.array(z.enum(["workspace_read", "workspace_write", "workspace_delete", "network", "process"])).max(5),
    }).strict(),
    z.object({ ...base, ...agent, kind: z.literal("review"), targetNodeIds: z.array(key).min(1).max(200),
      criteria: z.array(z.object({ key, description: text }).strict()).min(1).max(100),
      maxRevisions: z.number().int().min(0).max(10), onReject: z.enum(["revise", "stop"]),
    }).strict(),
    z.object({ ...base, kind: z.literal("approval"), message: text,
      options: z.array(z.object({ value: text, label: text, description: text }).strict()).min(1).max(20), allowComment: z.boolean(),
    }).strict(),
  ])).min(1).max(200),
}).strict();

export const workflowPlanningStateSchema = z.object({
  agentId: z.string().min(1).max(200),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: text.min(1) }).strict()).max(100),
  proposal: proposalSchema.optional(),
}).strict().refine((value) => JSON.stringify(value).length <= 500_000, "Planning conversation is too large. Start a new Workflow.");

export const workflowPlanningDefinitionSchema = proposalSchema.extend({
  nodes: z.array(proposalSchema.shape.nodes.element).max(200),
  id: z.string().min(1).max(200),
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
  workDir: z.string().max(4000).nullable().optional(),
  isTemplate: z.boolean().optional(), planning: workflowPlanningStateSchema.optional(),
}).strict().refine((value) => JSON.stringify(value).length <= 650_000, "Workflow planning input is too large.");

const responseSchema = z.object({ message: text.min(1), proposal: proposalSchema.optional() }).strict();

export class WorkflowPlanningService {
  constructor(private readonly dependencies: {
    executor: Pick<ConfiguredAgentExecutionService, "runOneShot">;
    agents: () => Array<{ id: string; name: string }>;
  }) {}

  async reply(request: WorkflowPlanningRequest, signal: AbortSignal): Promise<WorkflowPlanningState> {
    if (request.definition.isTemplate) throw new Error("Copy the template before planning changes.");
    const agents = this.dependencies.agents();
    if (!agents.some((agent) => agent.id === request.agentId)) throw new Error("Select an available planning Agent.");
    workflowPlanningDefinitionSchema.parse(request.definition);
    const previous = request.definition.planning ? workflowPlanningStateSchema.parse(request.definition.planning) : undefined;
    if ((previous?.messages.length ?? 0) > 98) throw new Error("Planning conversation is full. Start a new Workflow.");
    const message = request.message.trim();
    if (!message) throw new Error("Describe your goal or answer the question first.");
    const messages: WorkflowPlanningState["messages"] = [...(previous?.messages ?? []), { role: "user", content: message }];
    workflowPlanningStateSchema.parse({ agentId: request.agentId, messages });
    const { planning: _planning, ...definition } = request.definition;
    const prompt = [
      "You are the Workflow planning Agent in AgentRecall. Restore the grill-me interview method:",
      "Ask exactly one material question at a time, include a recommended answer and a brief tradeoff. Resolve that decision before the next question.",
      "Clarify the objective, inputs, desired outputs, constraints, dependencies, failure handling and success criteria only where needed. Do not ask about internal field names or facts already supplied.",
      "Stop asking once the information is sufficient and propose the smallest useful executable graph. Simple complete requests need no artificial interview rounds.",
      "This is authoring only. Do not execute the task, modify files, call workflow_create, start runs or publish anything. Return the proposal for the user to review and apply in the editor.",
      "Preserve the user's current graph and manual edits unless the requested change requires replacing them. Use only Agent IDs from the catalog. Never create start/end placeholders or edges; dependencies come from node input references.",
      "Use script nodes for deterministic work, agent nodes for reasoning, review nodes for checking upstream results, approval nodes for human decisions. Declare every input and output with its type and description.",
      "Review nodes consume outputs of their upstream targetNodeIds and declare required outputs verdict:text, criteriaResults:list, feedback:text. Approval nodes declare required outputs decision:text and comment:text.",
      "Script nodes receive one JSON object on stdin and return one JSON object on stdout matching their output fields. Declare all needed permissions. Do not hide required user inputs in code.",
      request.intent === "generate"
        ? "The user explicitly requests generation now. Use reasonable defaults, explain remaining assumptions in message, and return a proposal. Ask one question only if a material unresolved decision prevents a useful workflow."
        : "Continue the interview. Include a proposal only if the goal is sufficiently understood; otherwise return only the next question in message.",
      "Respond in the user's language. Return one JSON object conforming to this schema, with no extra text:",
      JSON.stringify(z.toJSONSchema(responseSchema)),
      "Available Agents:", JSON.stringify(agents),
      "Current editable Workflow:", JSON.stringify(definition),
      "Previous proposed Workflow (not yet applied):", JSON.stringify(previous?.proposal ?? null),
      "Conversation:", JSON.stringify(messages),
    ].join("\n");
    if (prompt.length > 750_000) throw new Error("Planning context is too large. Start a new Workflow or shorten its contents.");
    signal.throwIfAborted();
    const result = await this.dependencies.executor.runOneShot({
      configuredAgentId: request.agentId, prompt,
      workDir: request.definition.workDir ?? undefined,
      developerInstructions: "You are in Workflow design mode. Only interview and propose a workflow; do not perform the task or change files or external systems.",
    }, undefined, signal);
    signal.throwIfAborted();
    const response = responseSchema.parse(parseWorkflowAgentOutputs(result.output));
    if (response.proposal) {
      const candidate: WorkflowDefinition = { ...definition, ...response.proposal };
      const issues = validateWorkflowDefinition(candidate, new Set(agents.map((agent) => agent.id)));
      if (issues.length) throw new Error(`The proposed Workflow is invalid: ${issues[0]!.path}: ${issues[0]!.message}`);
    }
    return workflowPlanningStateSchema.parse({
      agentId: request.agentId,
      messages: [...messages, { role: "assistant", content: response.message }],
      ...(response.proposal ? { proposal: response.proposal } : {}),
    });
  }
}
