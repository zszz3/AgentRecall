import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import {
  isWorkflowV2HookJsonValue,
  isWorkflowV2HookVariableName,
  resolveWorkflowV2HookActions,
  WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES,
  workflowV2HookActionValidationErrors,
  type WorkflowV2HookActionDef,
  type WorkflowV2HookActionKind,
  type WorkflowV2HookLifecycle,
  type WorkflowV2NodeHooks,
  type WorkflowV2ResolvedHookAction,
} from "../../../shared/workflow-v2/hooks";

export interface WorkflowV2HookExecutionContext {
  workflowId: string;
  runId: string;
  nodeId: string;
  lifecycle: WorkflowV2HookLifecycle;
  runContext: string;
  output?: WorkflowV2WorkerOutput;
  variables: Readonly<Record<string, unknown>>;
}

export interface WorkflowV2HookHandlerResult {
  variables?: Record<string, unknown>;
  injectedContext?: string[];
  control?: { action: "pause" | "skip"; reason: string };
}

export interface WorkflowV2HookRecord {
  lifecycle: WorkflowV2HookLifecycle;
  kind: WorkflowV2HookActionKind;
  source: WorkflowV2ResolvedHookAction["source"];
  status: "completed" | "skipped";
  detail?: string;
}

export interface WorkflowV2HookChainResult {
  variables: Record<string, unknown>;
  injectedContext: string[];
  records: WorkflowV2HookRecord[];
}

export type WorkflowV2HookHandler = (
  action: WorkflowV2ResolvedHookAction,
  context: WorkflowV2HookExecutionContext,
) => Promise<WorkflowV2HookHandlerResult | void> | WorkflowV2HookHandlerResult | void;

interface WorkflowV2RegisteredHook {
  allowedLifecycles: ReadonlySet<WorkflowV2HookLifecycle>;
  handler: WorkflowV2HookHandler;
}

export class WorkflowV2HookSignal extends Error {
  constructor(
    readonly action: "pause" | "skip",
    readonly lifecycle: WorkflowV2HookLifecycle,
    readonly reason: string,
    readonly variables: Record<string, unknown> = {},
    readonly injectedContext: string[] = [],
    readonly records: WorkflowV2HookRecord[] = [],
  ) {
    super(reason);
    this.name = "WorkflowV2HookSignal";
  }
}

export class WorkflowV2HookRegistry {
  private readonly hooks = new Map<WorkflowV2HookActionKind, WorkflowV2RegisteredHook>();

  register(input: {
    kind: WorkflowV2HookActionKind;
    allowedLifecycles: readonly WorkflowV2HookLifecycle[];
    handler: WorkflowV2HookHandler;
  }): void {
    if (this.hooks.has(input.kind)) throw new Error(`Workflow V2 hook ${input.kind} is already registered.`);
    if (input.allowedLifecycles.length === 0) throw new Error(`Workflow V2 hook ${input.kind} requires a lifecycle.`);
    this.hooks.set(input.kind, {
      allowedLifecycles: new Set(input.allowedLifecycles),
      handler: input.handler,
    });
  }

  async execute(
    action: WorkflowV2ResolvedHookAction,
    context: WorkflowV2HookExecutionContext,
  ): Promise<WorkflowV2HookHandlerResult> {
    const registered = this.hooks.get(action.kind);
    if (!registered) throw new Error(`Workflow V2 hook ${action.kind} is not registered in the main process.`);
    if (!registered.allowedLifecycles.has(context.lifecycle)) {
      throw new Error(`Workflow V2 hook ${action.kind} is not allowed during ${context.lifecycle}.`);
    }
    const result = await registered.handler(structuredClone(action), structuredClone(context));
    if (result === undefined) return {};
    assertHookHandlerResult(result);
    return structuredClone(result);
  }
}

export function createWorkflowV2HookRegistry(deps: {
  readMemory?: (key: string) => Promise<unknown>;
  writeMemory?: (key: string, value: unknown) => Promise<void>;
  writeFile?: (relativePath: string, content: string) => Promise<void>;
  runReadOnlyLlm?: (input: { prompt: string; context: WorkflowV2HookExecutionContext }) => Promise<unknown>;
} = {}): WorkflowV2HookRegistry {
  const registry = new WorkflowV2HookRegistry();
  registry.register({
    kind: "pause",
    allowedLifecycles: WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES.pause,
    handler: (action) => ({ control: { action: "pause", reason: configString(action, "reason") ?? "Paused by Workflow V2 hook." } }),
  });
  registry.register({
    kind: "skip",
    allowedLifecycles: WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES.skip,
    handler: (action) => ({ control: { action: "skip", reason: configString(action, "reason") ?? "Skipped by Workflow V2 hook." } }),
  });
  registry.register({
    kind: "setVariable",
    allowedLifecycles: WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES.setVariable,
    handler: (action) => {
      const key = requiredVariableName(action, "key");
      const value = action.config?.value;
      if (!isWorkflowV2HookJsonValue(value)) throw new Error("Workflow V2 setVariable hook requires a JSON value.");
      return { variables: { [key]: structuredClone(value) } };
    },
  });
  registry.register({
    kind: "injectContext",
    allowedLifecycles: WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES.injectContext,
    handler: (action, context) => {
      const text = configString(action, "text");
      const variableName = configString(action, "fromVariable");
      const value = text ?? (variableName ? context.variables[variableName] : undefined);
      if (value === undefined) throw new Error("Workflow V2 injectContext hook could not resolve its source.");
      return { injectedContext: [typeof value === "string" ? value : JSON.stringify(value)] };
    },
  });
  registry.register({
    kind: "readMemory",
    allowedLifecycles: WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES.readMemory,
    handler: async (action) => {
      if (!deps.readMemory) throw new Error("Workflow V2 readMemory hook is unavailable.");
      const key = requiredConfigString(action, "key");
      const outputVariable = requiredVariableName(action, "outputVariable");
      const value = await deps.readMemory(key);
      if (!isWorkflowV2HookJsonValue(value)) throw new Error("Workflow V2 readMemory hook returned a non-JSON value.");
      return { variables: { [outputVariable]: structuredClone(value) } };
    },
  });
  registry.register({
    kind: "writeMemory",
    allowedLifecycles: WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES.writeMemory,
    handler: async (action, context) => {
      if (!deps.writeMemory) throw new Error("Workflow V2 writeMemory hook is unavailable.");
      const key = requiredConfigString(action, "key");
      const value = resolveConfiguredValue(action, context);
      await deps.writeMemory(key, structuredClone(value));
    },
  });
  registry.register({
    kind: "writeFile",
    allowedLifecycles: WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES.writeFile,
    handler: async (action, context) => {
      if (!deps.writeFile) throw new Error("Workflow V2 writeFile hook is unavailable.");
      const relativePath = requiredConfigString(action, "path");
      const value = resolveConfiguredValue(action, context);
      await deps.writeFile(relativePath, typeof value === "string" ? value : JSON.stringify(value, null, 2));
    },
  });
  registry.register({
    kind: "llmHook",
    allowedLifecycles: WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES.llmHook,
    handler: async (action, context) => {
      if (!deps.runReadOnlyLlm) throw new Error("Workflow V2 llmHook is unavailable.");
      const outputVariable = requiredVariableName(action, "outputVariable");
      const value = await deps.runReadOnlyLlm({ prompt: requiredConfigString(action, "prompt"), context });
      if (!isWorkflowV2HookJsonValue(value)) throw new Error("Workflow V2 llmHook returned a non-JSON value.");
      return { variables: { [outputVariable]: structuredClone(value) } };
    },
  });
  return registry;
}

export async function runWorkflowV2HookChain(input: {
  hooks: WorkflowV2NodeHooks | undefined;
  lifecycle: WorkflowV2HookLifecycle;
  context: Omit<WorkflowV2HookExecutionContext, "lifecycle" | "variables">;
  variables?: Readonly<Record<string, unknown>>;
  registry: WorkflowV2HookRegistry;
}): Promise<WorkflowV2HookChainResult> {
  const variables = structuredClone(input.variables ?? {});
  const injectedContext: string[] = [];
  const records: WorkflowV2HookRecord[] = [];
  for (const action of resolveWorkflowV2HookActions(input.hooks, input.lifecycle)) {
    const validationErrors = workflowV2HookActionValidationErrors(action, input.lifecycle);
    if (validationErrors.length > 0) throw new Error(`Workflow V2 hook is invalid: ${validationErrors.join(" ")}`);
    try {
      const result = await input.registry.execute(action, {
        ...structuredClone(input.context),
        lifecycle: input.lifecycle,
        variables: structuredClone(variables),
      });
      Object.assign(variables, result.variables ?? {});
      injectedContext.push(...(result.injectedContext ?? []));
      records.push({ lifecycle: input.lifecycle, kind: action.kind, source: action.source, status: "completed" });
      if (result.control) {
        throw new WorkflowV2HookSignal(
          result.control.action,
          input.lifecycle,
          result.control.reason,
          structuredClone(variables),
          [...injectedContext],
          structuredClone(records),
        );
      }
    } catch (error) {
      if (error instanceof WorkflowV2HookSignal) {
        throw new WorkflowV2HookSignal(
          error.action,
          error.lifecycle,
          error.reason,
          Object.keys(error.variables).length > 0 ? error.variables : structuredClone(variables),
          error.injectedContext.length > 0 ? error.injectedContext : [...injectedContext],
          error.records.length > 0 ? error.records : structuredClone(records),
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      const failurePolicy = action.failurePolicy ?? "fail_node";
      if (failurePolicy === "skip_hook") {
        records.push({ lifecycle: input.lifecycle, kind: action.kind, source: action.source, status: "skipped", detail: reason });
        continue;
      }
      if (failurePolicy === "pause_run") {
        throw new WorkflowV2HookSignal(
          "pause",
          input.lifecycle,
          reason,
          structuredClone(variables),
          [...injectedContext],
          structuredClone(records),
        );
      }
      throw new Error(`Workflow V2 hook ${action.kind} failed during ${input.lifecycle}: ${reason}`);
    }
  }
  if (!isWorkflowV2HookJsonValue(variables)) throw new Error("Workflow V2 hook variables are not JSON serializable.");
  if (injectedContext.join("\n").length > 12_000) throw new Error("Workflow V2 injected hook context exceeds 12000 characters.");
  return { variables, injectedContext, records };
}

function assertHookHandlerResult(value: unknown): asserts value is WorkflowV2HookHandlerResult {
  if (!isRecord(value)) throw new Error("Workflow V2 hook handler must return an object.");
  if (Object.keys(value).some((key) => key !== "variables" && key !== "injectedContext" && key !== "control")) {
    throw new Error("Workflow V2 hook handler returned a forbidden field.");
  }
  if (value.variables !== undefined && (!isRecord(value.variables) || !isWorkflowV2HookJsonValue(value.variables))) {
    throw new Error("Workflow V2 hook handler returned invalid variables.");
  }
  if (value.injectedContext !== undefined
    && (!Array.isArray(value.injectedContext) || !value.injectedContext.every((item) => typeof item === "string"))) {
    throw new Error("Workflow V2 hook handler returned invalid injected context.");
  }
  if (value.control !== undefined) {
    if (!isRecord(value.control)
      || (value.control.action !== "pause" && value.control.action !== "skip")
      || typeof value.control.reason !== "string"
      || !value.control.reason.trim()) {
      throw new Error("Workflow V2 hook handler returned invalid flow control.");
    }
  }
}

function resolveConfiguredValue(action: WorkflowV2HookActionDef, context: WorkflowV2HookExecutionContext): unknown {
  if (action.config && Object.hasOwn(action.config, "value")) {
    const value = action.config.value;
    if (!isWorkflowV2HookJsonValue(value)) throw new Error(`Workflow V2 ${action.kind} hook requires a JSON value.`);
    return value;
  }
  const variableName = requiredVariableName(action, "fromVariable");
  if (!Object.hasOwn(context.variables, variableName)) {
    throw new Error(`Workflow V2 ${action.kind} hook variable ${variableName} was not found.`);
  }
  return context.variables[variableName];
}

function configString(action: WorkflowV2HookActionDef, key: string): string | undefined {
  const value = action.config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredConfigString(action: WorkflowV2HookActionDef, key: string): string {
  const value = configString(action, key);
  if (!value) throw new Error(`Workflow V2 ${action.kind} hook requires config.${key}.`);
  return value;
}

function requiredVariableName(action: WorkflowV2HookActionDef, key: string): string {
  const value = action.config?.[key];
  if (!isWorkflowV2HookVariableName(value)) throw new Error(`Workflow V2 ${action.kind} hook requires a valid config.${key}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
