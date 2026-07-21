export type WorkflowV2HookLifecycle = "beforeExecute" | "afterOutput" | "afterComplete";
export type WorkflowV2HookSource = "template" | "node" | "user";
export type WorkflowV2HookFailurePolicy = "fail_node" | "pause_run" | "skip_hook";
export type WorkflowV2HookActionKind =
  | "pause"
  | "skip"
  | "injectContext"
  | "setVariable"
  | "readMemory"
  | "writeMemory"
  | "writeFile"
  | "llmHook";

export interface WorkflowV2HookActionDef {
  kind: WorkflowV2HookActionKind;
  config?: Record<string, unknown>;
  source?: WorkflowV2HookSource;
  failurePolicy?: WorkflowV2HookFailurePolicy;
}

export interface WorkflowV2NodeHooks {
  beforeExecute?: WorkflowV2HookActionDef[];
  afterOutput?: WorkflowV2HookActionDef[];
  afterComplete?: WorkflowV2HookActionDef[];
}

export interface WorkflowV2ResolvedHookAction extends WorkflowV2HookActionDef {
  source: WorkflowV2HookSource;
  lifecycle: WorkflowV2HookLifecycle;
  order: number;
}

const HOOK_LIFECYCLES: WorkflowV2HookLifecycle[] = ["beforeExecute", "afterOutput", "afterComplete"];

export const WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES = {
  pause: ["beforeExecute", "afterOutput"],
  skip: ["beforeExecute", "afterOutput"],
  injectContext: ["beforeExecute"],
  setVariable: ["beforeExecute", "afterOutput", "afterComplete"],
  readMemory: ["beforeExecute", "afterOutput", "afterComplete"],
  writeMemory: ["afterOutput", "afterComplete"],
  writeFile: ["afterOutput", "afterComplete"],
  llmHook: ["afterOutput", "afterComplete"],
} as const satisfies Record<WorkflowV2HookActionKind, readonly WorkflowV2HookLifecycle[]>;

const HOOK_ACTION_KINDS = new Set<WorkflowV2HookActionKind>([
  "pause",
  "skip",
  "injectContext",
  "setVariable",
  "readMemory",
  "writeMemory",
  "writeFile",
  "llmHook",
]);

const FORBIDDEN_CONFIG_KEYS = new Set([
  "edge",
  "edges",
  "route",
  "routing",
  "nextNodeId",
  "targetNodeId",
  "graphVersion",
  "reviewDecision",
]);

const HOOK_CONFIG_KEYS: Record<WorkflowV2HookActionKind, ReadonlySet<string>> = {
  pause: new Set(["reason"]),
  skip: new Set(["reason"]),
  injectContext: new Set(["text", "fromVariable"]),
  setVariable: new Set(["key", "value"]),
  readMemory: new Set(["key", "outputVariable"]),
  writeMemory: new Set(["key", "value", "fromVariable"]),
  writeFile: new Set(["path", "value", "fromVariable"]),
  llmHook: new Set(["readOnly", "modelProfile", "prompt", "outputVariable"]),
};

export function composeWorkflowV2NodeHooks(input: {
  template?: WorkflowV2NodeHooks;
  node?: WorkflowV2NodeHooks;
  user?: WorkflowV2NodeHooks;
}): WorkflowV2NodeHooks | undefined {
  const result: WorkflowV2NodeHooks = {};
  for (const lifecycle of HOOK_LIFECYCLES) {
    const actions = [
      ...withSource(input.template?.[lifecycle], "template"),
      ...withSource(input.node?.[lifecycle], "node"),
      ...withSource(input.user?.[lifecycle], "user"),
    ];
    if (actions.length > 0) result[lifecycle] = actions;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function resolveWorkflowV2HookActions(
  hooks: WorkflowV2NodeHooks | undefined,
  lifecycle: WorkflowV2HookLifecycle,
): WorkflowV2ResolvedHookAction[] {
  return (hooks?.[lifecycle] ?? []).map((action, order) => ({
    ...structuredClone(action),
    source: action.source ?? "node",
    lifecycle,
    order,
  }));
}

export function workflowV2NodeHookValidationErrors(hooks: unknown): string[] {
  if (hooks === undefined) return [];
  if (!isRecord(hooks)) return ["hooks must be an object."];
  const errors: string[] = [];
  for (const key of Object.keys(hooks)) {
    if (!HOOK_LIFECYCLES.includes(key as WorkflowV2HookLifecycle)) {
      errors.push(`hooks contains unsupported lifecycle ${key}.`);
    }
  }
  for (const lifecycle of HOOK_LIFECYCLES) {
    const actions = hooks[lifecycle];
    if (actions === undefined) continue;
    if (!Array.isArray(actions)) {
      errors.push(`hooks.${lifecycle} must be an array.`);
      continue;
    }
    actions.forEach((action, index) => {
      errors.push(
        ...workflowV2HookActionValidationErrors(action, lifecycle).map(
          (error) => `hooks.${lifecycle}[${index}] ${error}`,
        ),
      );
    });
  }
  return errors;
}

export function workflowV2HookActionValidationErrors(
  action: unknown,
  lifecycle: WorkflowV2HookLifecycle,
): string[] {
  if (!isRecord(action)) return ["must be an object."];
  const errors: string[] = [];
  if (!HOOK_ACTION_KINDS.has(action.kind as WorkflowV2HookActionKind)) {
    errors.push(`has unsupported action kind ${String(action.kind)}.`);
    return errors;
  }
  const actionKind = action.kind as WorkflowV2HookActionKind;
  if (
    !(WORKFLOW_V2_HOOK_ALLOWED_LIFECYCLES[actionKind] as readonly WorkflowV2HookLifecycle[]).includes(
      lifecycle,
    )
  ) {
    errors.push(`${actionKind} is not allowed during ${lifecycle}.`);
  }
  if (
    action.source !== undefined
    && action.source !== "template"
    && action.source !== "node"
    && action.source !== "user"
  ) {
    errors.push("has an invalid source.");
  }
  if (
    action.failurePolicy !== undefined
    && action.failurePolicy !== "fail_node"
    && action.failurePolicy !== "pause_run"
    && action.failurePolicy !== "skip_hook"
  ) {
    errors.push("has an invalid failure policy.");
  }
  if (action.config !== undefined) {
    if (!isRecord(action.config)) errors.push("config must be an object.");
    else {
      const forbiddenPath = findForbiddenConfigPath(action.config);
      if (forbiddenPath) errors.push(`config cannot contain routing or review field ${forbiddenPath}.`);
      if (!isJsonValue(action.config)) errors.push("config must contain only finite JSON values.");
      for (const key of Object.keys(action.config)) {
        if (!HOOK_CONFIG_KEYS[actionKind].has(key)) {
          errors.push(`config contains unsupported field config.${key}.`);
        }
      }
    }
  }
  if (action.kind === "llmHook") {
    const config = isRecord(action.config) ? action.config : {};
    if (config.readOnly !== true) errors.push("llmHook must set readOnly=true.");
    if (config.modelProfile !== "fast") errors.push("llmHook must use modelProfile=fast.");
    if (typeof config.prompt !== "string" || !config.prompt.trim() || config.prompt.length > 2_000) {
      errors.push("llmHook prompt must contain 1-2000 characters.");
    }
    if (!isVariableName(config.outputVariable)) errors.push("llmHook requires a valid outputVariable.");
  }
  if (action.kind === "setVariable") {
    const config = isRecord(action.config) ? action.config : {};
    if (!isVariableName(config.key)) errors.push("setVariable requires a valid key.");
    if (!Object.hasOwn(config, "value") || !isJsonValue(config.value)) {
      errors.push("setVariable requires a JSON value.");
    }
  }
  if (action.kind === "injectContext") {
    const config = isRecord(action.config) ? action.config : {};
    const hasText = typeof config.text === "string" && config.text.trim().length > 0;
    const hasVariable = isVariableName(config.fromVariable);
    if (hasText === hasVariable) errors.push("injectContext requires exactly one of text or fromVariable.");
  }
  if (action.kind === "pause" || action.kind === "skip") {
    const reason = isRecord(action.config) ? action.config.reason : undefined;
    if (reason !== undefined && (typeof reason !== "string" || !reason.trim())) {
      errors.push(`${action.kind} reason must be a non-empty string when provided.`);
    }
  }
  if (action.kind === "readMemory") {
    const config = isRecord(action.config) ? action.config : {};
    if (!isBoundedString(config.key, 512)) errors.push("readMemory requires a non-empty key.");
    if (!isVariableName(config.outputVariable)) errors.push("readMemory requires a valid outputVariable.");
  }
  if (action.kind === "writeMemory" || action.kind === "writeFile") {
    const config = isRecord(action.config) ? action.config : {};
    const key = action.kind === "writeMemory" ? "key" : "path";
    if (!isBoundedString(config[key], 512)) errors.push(`${action.kind} requires a non-empty ${key}.`);
    if (action.kind === "writeFile" && isUnsafeRelativePath(config.path)) {
      errors.push("writeFile path must be a safe relative path.");
    }
    const hasValue = Object.hasOwn(config, "value") && isJsonValue(config.value);
    const hasVariable = isVariableName(config.fromVariable);
    if (hasValue === hasVariable) errors.push(`${action.kind} requires exactly one of value or fromVariable.`);
  }
  return errors;
}

function withSource(
  actions: readonly WorkflowV2HookActionDef[] | undefined,
  source: WorkflowV2HookSource,
): WorkflowV2HookActionDef[] {
  return (actions ?? []).map((action) => ({ ...structuredClone(action), source }));
}

function findForbiddenConfigPath(value: Record<string, unknown>, parent = "config"): string | undefined {
  for (const [key, item] of Object.entries(value)) {
    const path = `${parent}.${key}`;
    if (FORBIDDEN_CONFIG_KEYS.has(key)) return path;
    if (isRecord(item)) {
      const nested = findForbiddenConfigPath(item, path);
      if (nested) return nested;
    }
    if (Array.isArray(item)) {
      for (const [index, entry] of item.entries()) {
        if (!isRecord(entry)) continue;
        const nested = findForbiddenConfigPath(entry, `${path}[${index}]`);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

export function isWorkflowV2HookVariableName(value: unknown): value is string {
  return isVariableName(value);
}

export function isWorkflowV2HookJsonValue(value: unknown): boolean {
  return isJsonValue(value);
}

function isVariableName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isUnsafeRelativePath(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some((segment) => segment === ".." || segment === "")
    || normalized.includes("\0");
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
