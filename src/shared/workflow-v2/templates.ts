import type {
  WorkflowV2AuthoredDefinition,
  WorkflowV2AuthoredNode,
  WorkflowV2Definition,
  WorkflowV2LLMNode,
  WorkflowV2Node,
  WorkflowV2NodeTemplate,
  WorkflowV2ScriptNode,
  WorkflowV2ScriptSpec,
  WorkflowV2TemplateNodeDraft,
  WorkflowV2TemplateParamValue,
} from "./definition";
import { composeWorkflowV2NodeHooks } from "./hooks";

export class WorkflowV2TemplateCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowV2TemplateCompileError";
  }
}

export interface WorkflowV2TemplateRegistry {
  templates: ReadonlyMap<string, WorkflowV2NodeTemplate>;
}

export function createWorkflowV2TemplateRegistry(
  templates: WorkflowV2NodeTemplate[],
): WorkflowV2TemplateRegistry {
  return { templates: new Map(templates.map((template) => [template.id, template])) };
}

export function isWorkflowV2TemplateNodeDraft(
  node: WorkflowV2AuthoredNode,
): node is WorkflowV2TemplateNodeDraft {
  return "templateId" in node;
}

function renderTemplateValue(
  value: string,
  params: Record<string, WorkflowV2TemplateParamValue> | undefined,
): string {
  return value.replace(/\{\{\s*params\.([A-Za-z0-9_-]+)\s*\}\}/g, (_, key: string) => {
    const resolved = params?.[key];
    if (resolved === undefined) return "";
    return Array.isArray(resolved) ? resolved.join(", ") : String(resolved);
  });
}

function renderScriptSpec(
  script: WorkflowV2ScriptSpec,
  params: Record<string, WorkflowV2TemplateParamValue> | undefined,
): WorkflowV2ScriptSpec {
  return {
    ...script,
    executable:
      script.executable.kind === "inline"
        ? { ...script.executable, code: renderTemplateValue(script.executable.code, params) }
        : {
            ...script.executable,
            ...(script.executable.args
              ? {
                  args: script.executable.args.map((argument) =>
                    renderTemplateValue(argument, params),
                  ),
                }
              : {}),
          },
    parameters: script.parameters.map((parameter) => ({
      ...parameter,
      ...(parameter.enum ? { enum: [...parameter.enum] } : {}),
    })),
    capabilities: [...script.capabilities],
    managerRisk: { ...script.managerRisk },
  };
}

function resolvePrompt(basePrompt: string, overridePrompt: string | undefined): string {
  if (!overridePrompt) return basePrompt;
  return overridePrompt.includes("{{templatePrompt}}")
    ? overridePrompt.replace(/\{\{\s*templatePrompt\s*\}\}/g, basePrompt)
    : overridePrompt;
}

export function compileWorkflowV2Node(
  node: WorkflowV2AuthoredNode,
  registry: WorkflowV2TemplateRegistry,
): WorkflowV2Node {
  if (!isWorkflowV2TemplateNodeDraft(node)) return node;

  const template = registry.templates.get(node.templateId);
  if (!template) {
    throw new WorkflowV2TemplateCompileError(`Unknown workflow-v2 template: ${node.templateId}`);
  }

  const overrides = node.overrides ?? {};
  const title = overrides.title ?? template.title ?? template.kind;
  const kind = overrides.kind ?? template.kind;
  const role = overrides.role ?? template.role;
  const outputFields = overrides.outputFields ?? template.outputFields;
  const hooks = composeWorkflowV2NodeHooks({
    ...(template.hooks ? { template: template.hooks } : {}),
    ...(overrides.hooks ? { user: overrides.hooks } : {}),
  });
  const resourceLocks = overrides.resourceLocks ?? template.resourceLocks;
  const executionLease = overrides.executionLease ?? template.executionLease;

  if (template.execModel === "llm") {
    const compiled: WorkflowV2LLMNode = {
      id: node.id,
      title,
      kind,
      execModel: "llm",
      executionMode: "one-shot",
      outputFields,
      prompt: resolvePrompt(renderTemplateValue(template.prompt, node.params), overrides.prompt),
      ...(role ? { role } : {}),
      ...(hooks ? { hooks } : {}),
      ...(resourceLocks ? { resourceLocks } : {}),
      ...(executionLease ? { executionLease: { ...executionLease } } : {}),
      ...(overrides.modelProfile ?? template.modelProfile
        ? { modelProfile: overrides.modelProfile ?? template.modelProfile }
        : {}),
      ...(overrides.configuredAgentId ?? template.configuredAgentId
        ? { configuredAgentId: overrides.configuredAgentId ?? template.configuredAgentId }
        : {}),
      ...(overrides.modelId ?? template.modelId
        ? { modelId: overrides.modelId ?? template.modelId }
        : {}),
      ...(overrides.judgeDimensions ?? template.judgeDimensions
        ? { judgeDimensions: overrides.judgeDimensions ?? template.judgeDimensions }
        : {}),
      ...(overrides.constraints ?? template.constraints
        ? { constraints: overrides.constraints ?? template.constraints }
        : {}),
      ...((overrides.maxRetry ?? template.maxRetry) !== undefined
        ? { maxRetry: overrides.maxRetry ?? template.maxRetry }
        : {}),
      ...(overrides.onExhausted ?? template.onExhausted
        ? { onExhausted: overrides.onExhausted ?? template.onExhausted }
        : {}),
      ...(overrides.requiredTools ?? template.requiredTools
        ? { requiredTools: overrides.requiredTools ?? template.requiredTools }
        : {}),
      ...(overrides.contextBudget ?? template.contextBudget
        ? { contextBudget: overrides.contextBudget ?? template.contextBudget }
        : {}),
    };
    return compiled;
  }

  const compiled: WorkflowV2ScriptNode = {
    id: node.id,
    title,
    kind,
    execModel: "script",
    executionMode: "script",
    outputFields,
    script: overrides.script ?? renderScriptSpec(template.script, node.params),
    ...(role ? { role } : {}),
    ...(hooks ? { hooks } : {}),
    ...(resourceLocks ? { resourceLocks } : {}),
    ...(executionLease ? { executionLease: { ...executionLease } } : {}),
    ...((overrides.expectedExitCode ?? template.expectedExitCode) !== undefined
      ? { expectedExitCode: overrides.expectedExitCode ?? template.expectedExitCode }
      : {}),
    ...(overrides.onError ?? template.onError
      ? { onError: overrides.onError ?? template.onError }
      : {}),
  };
  return compiled;
}

export function compileWorkflowV2Definition(
  definition: WorkflowV2AuthoredDefinition,
  registry: WorkflowV2TemplateRegistry,
): WorkflowV2Definition {
  return {
    workflowId: definition.workflowId,
    graphVersion: definition.graphVersion,
    objective: definition.objective,
    nodes: definition.nodes.map((node) => compileWorkflowV2Node(node, registry)),
    edges: definition.edges.map((edge) => ({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
    })),
  };
}
