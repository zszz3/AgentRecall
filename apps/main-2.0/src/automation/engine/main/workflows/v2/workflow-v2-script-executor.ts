import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import type { WorkflowV2ScriptExecutionReceipt, WorkflowV2ScriptWorkerOutput } from "../../../shared/workflow-v2/packets";
import { sanitizeWorkflowTransactionValue } from "../../../shared/workflow-v2/transaction";
import type { ExecuteWorkflowV2ScriptRequest } from "../workflow-runtime-ports";
import { workflowV2ScriptCapabilityDigest, workflowV2ScriptOperationDigest } from "./workflow-v2-script-analysis";

const workflowScriptRequire = createRequire(import.meta.url);

export function assertWorkflowV2ScriptAuthorized(input: ExecuteWorkflowV2ScriptRequest): void {
  if (input.authorization.nodeId !== input.node.id) throw new Error("Script authorization does not belong to this node.");
  if (input.authorization.decision !== "auto_allow" && input.authorization.decision !== "allow_once") throw new Error("Script execution is not authorized.");
  if (input.authorization.capabilityDigest !== workflowV2ScriptCapabilityDigest(input.authorization.capabilities)) throw new Error("Script authorization capability digest does not match its capabilities.");
  if (input.authorization.decision === "allow_once" && !input.authorization.approvalRequestId) throw new Error("One-time script authorization has no approval request identity.");
  const operationDigest = workflowV2ScriptOperationDigest({
    workflowId: input.authorization.workflowId,
    graphVersion: input.authorization.graphVersion,
    runId: input.authorization.runId,
    node: input.node,
    workDir: input.workDir,
    inputs: input.inputs,
  });
  if (input.authorization.operationDigest !== operationDigest) throw new Error("Script authorization does not match the concrete operation.");
}

export function validateWorkflowV2ScriptOutput(input: ExecuteWorkflowV2ScriptRequest, output: Record<string, unknown>): void {
  const schema = input.node.script.outputSchema;
  for (const key of schema?.required ?? []) {
    if (!(key in output) || output[key] === undefined || output[key] === null) throw new Error(`Workflow V2 script output is missing required field ${key}.`);
  }
  for (const [key, property] of Object.entries(schema?.properties ?? {})) {
    const value = output[key];
    if (value === undefined) continue;
    if (value === null) {
      if (!property.nullable && property.type !== "null") throw new Error(`Workflow V2 script output field ${key} must not be null.`);
      continue;
    }
    if (!matchesSchemaType(value, property.type)) throw new Error(`Workflow V2 script output field ${key} must be ${property.type}.`);
    if (property.type === "array" && property.items && !(value as unknown[]).every((item) => matchesSchemaType(item, property.items!.type))) {
      throw new Error(`Workflow V2 script output field ${key} contains an invalid array item.`);
    }
  }
}

function matchesSchemaType(value: unknown, type: "string" | "number" | "boolean" | "object" | "array" | "null"): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

export class WorkflowV2ScriptExecutionError extends Error {
  constructor(message: string, readonly receipt: WorkflowV2ScriptExecutionReceipt) {
    super(message);
    this.name = "WorkflowV2ScriptExecutionError";
  }
}

// Caps each stream at ~1M characters (about 2 MB of UTF-16 heap) so a chatty script cannot grow the main process heap without bound.
const MAX_CAPTURED_SCRIPT_OUTPUT_CHARS = 1_000_000;
const SCRIPT_OUTPUT_TRUNCATION_MARKER = "\n[truncated]";

function createBoundedScriptOutputCapture() {
  let text = "";
  let truncated = false;
  return {
    // Chunks past the cap are still consumed so the child never blocks on a full pipe.
    append(chunk: string): void {
      if (truncated) return;
      const budget = MAX_CAPTURED_SCRIPT_OUTPUT_CHARS - text.length;
      if (chunk.length <= budget) {
        text += chunk;
        return;
      }
      const kept = chunk.slice(0, Math.max(0, budget));
      // Dropping a split surrogate pair keeps the retained text encodable for durable storage.
      text += /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
      truncated = true;
    },
    value(): string {
      return truncated ? `${text}${SCRIPT_OUTPUT_TRUNCATION_MARKER}` : text;
    },
    get truncated(): boolean {
      return truncated;
    },
  };
}

async function executeCommand(input: ExecuteWorkflowV2ScriptRequest): Promise<{ outputs: Record<string, unknown>; receipt: WorkflowV2ScriptExecutionReceipt; outputTruncated: boolean }> {
  const executable = input.node.script.executable;
  if (executable.kind !== "command") throw new Error("Expected command executable.");
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(input.signal.reason instanceof Error ? input.signal.reason : new Error("Workflow V2 script was aborted."));
      return;
    }
    const child = spawn(executable.command, executable.args ?? [], { cwd: input.workDir, shell: false, windowsHide: true, detached: process.platform !== "win32" });
    const stdout = createBoundedScriptOutputCapture();
    const stderr = createBoundedScriptOutputCapture();
    let spawnError: Error | undefined;
    const abort = () => terminateWorkflowV2ScriptProcessTree(child.pid);
    input.signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.append(chunk));
    child.stderr.on("data", (chunk: string) => stderr.append(chunk));
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code, signal) => {
      input.signal.removeEventListener("abort", abort);
      const stdoutText = stdout.value();
      const stderrText = stderr.value();
      const receipt = scriptReceipt(input, { code, signal, stdout: stdoutText, stderr: stderrText, timedOut: isTimeoutAbort(input.signal) });
      const expectedExitCode = input.node.expectedExitCode ?? 0;
      if (spawnError || code !== expectedExitCode) {
        reject(new WorkflowV2ScriptExecutionError(spawnError?.message || stderrText.trim() || `Script exited with code ${code}.`, receipt));
        return;
      }
      if (stderrText.trim() && (input.node.script.stderrPolicy ?? "warn") === "fail") {
        reject(new WorkflowV2ScriptExecutionError("Workflow V2 script produced stderr while stderrPolicy is fail.", receipt));
        return;
      }
      resolve({ outputs: { stdout: stdoutText.trim() }, receipt, outputTruncated: stdout.truncated || stderr.truncated });
    });
  });
}

function terminateWorkflowV2ScriptProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* Process already exited. */ }
  }
}

class WorkflowV2InlineScriptTimeoutError extends Error {
  constructor() {
    super("Workflow V2 inline script timed out.");
    this.name = "WorkflowV2InlineScriptTimeoutError";
  }
}

async function executeInlineTypeScript(input: ExecuteWorkflowV2ScriptRequest, code: string): Promise<Record<string, unknown>> {
  if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Workflow V2 script was aborted.");
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs, 30_000));
  const value = runInNewContext(
    `"use strict"; (function(inputs) { ${code}\n})(inputs)`,
    {
      inputs: structuredClone(input.inputs),
      process,
      require: workflowScriptRequire,
      Buffer,
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      structuredClone,
    },
    { timeout: timeoutMs, contextCodeGeneration: { strings: false, wasm: false } },
  ) as unknown;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new WorkflowV2InlineScriptTimeoutError()), timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(input.signal.reason instanceof Error ? input.signal.reason : new Error("Workflow V2 script was aborted."));
      input.signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([Promise.resolve(value), deadline, aborted]) as Record<string, unknown>;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) input.signal.removeEventListener("abort", onAbort);
  }
}

export async function executeWorkflowV2Script(input: ExecuteWorkflowV2ScriptRequest): Promise<WorkflowV2ScriptWorkerOutput> {
  assertWorkflowV2ScriptAuthorized(input);
  const executable = input.node.script.executable;
  let outputs: Record<string, unknown>;
  let receipt: WorkflowV2ScriptExecutionReceipt;
  let outputTruncated = false;
  if (executable.kind === "command") {
    ({ outputs, receipt, outputTruncated } = await executeCommand(input));
  } else {
    try {
      outputs = executable.language === "typescript"
        ? await executeInlineTypeScript(input, executable.code)
        : (() => { throw new Error(`Inline ${executable.language} execution is not available.`); })();
      receipt = scriptReceipt(input, { code: 0, signal: null, stdout: JSON.stringify(outputs), stderr: "", timedOut: false });
    } catch (error) {
      const timedOut = error instanceof WorkflowV2InlineScriptTimeoutError
        || (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT")
        || isTimeoutAbort(input.signal);
      const failedReceipt = scriptReceipt(input, { code: 1, signal: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut });
      throw new WorkflowV2ScriptExecutionError(error instanceof Error ? error.message : String(error), failedReceipt);
    }
  }
  try {
    validateWorkflowV2ScriptOutput(input, outputs);
  } catch (error) {
    throw new WorkflowV2ScriptExecutionError(error instanceof Error ? error.message : String(error), receipt);
  }
  const stderrWarning = receipt.stderrSummary && (input.node.script.stderrPolicy ?? "warn") === "warn";
  const issues = [
    ...(stderrWarning ? [{ code: "script_stderr", severity: "warning" as const, detail: receipt.stderrSummary }] : []),
    ...(outputTruncated ? [{ code: "script_output_truncated", severity: "warning" as const, detail: "Script output exceeded the capture limit and was truncated." }] : []),
  ];
  return {
    nodeId: input.node.id,
    summary: `${input.node.title} completed.`,
    outputs,
    evidence: [],
    proposals: [],
    scriptReceipt: receipt,
    acceptance: {
      outcome: issues.length > 0 ? "degraded" : "clean",
      issues,
      changedPaths: [],
      operationIds: [],
    },
  };
}

function scriptReceipt(
  input: ExecuteWorkflowV2ScriptRequest,
  process: { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean },
): WorkflowV2ScriptExecutionReceipt {
  const effectMode = input.node.script.effectMode;
  const executionFailed = process.code !== (input.node.expectedExitCode ?? 0);
  const legacyCommandFailure = effectMode === undefined && input.node.script.executable.kind === "command" && executionFailed;
  const effectState = process.timedOut || input.signal.aborted || legacyCommandFailure || (effectMode === "brokered_external" && executionFailed)
    ? "unknown"
    : effectMode === "workspace_only"
      ? "workspace_changed"
      : effectMode === "brokered_external"
        ? "brokered"
        : "none";
  const sanitizedStderr = String(sanitizeWorkflowTransactionValue(process.stderr.trim())).slice(0, 1_000);
  return {
    exitCode: process.code,
    signal: process.signal,
    timedOut: process.timedOut,
    stderrSummary: sanitizedStderr,
    stdoutDigest: createHash("sha256").update(process.stdout).digest("hex"),
    operationDigest: input.authorization.operationDigest,
    effectState,
  };
}

function isTimeoutAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof Error && /timed out/i.test(signal.reason.message);
}
