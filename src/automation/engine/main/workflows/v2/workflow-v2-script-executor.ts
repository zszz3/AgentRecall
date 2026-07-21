import { spawn } from "node:child_process";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type { ExecuteWorkflowV2ScriptRequest } from "../workflow-runtime-ports";
import { workflowV2ScriptCapabilityDigest, workflowV2ScriptOperationDigest } from "./workflow-v2-script-analysis";

function assertAuthorized(input: ExecuteWorkflowV2ScriptRequest): void {
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

function validateOutput(input: ExecuteWorkflowV2ScriptRequest, output: Record<string, unknown>): void {
  for (const key of input.node.script.outputSchema?.required ?? []) {
    if (!(key in output)) throw new Error(`Workflow V2 script output is missing required field ${key}.`);
  }
}

async function executeCommand(input: ExecuteWorkflowV2ScriptRequest): Promise<Record<string, unknown>> {
  const executable = input.node.script.executable;
  if (executable.kind !== "command") throw new Error("Expected command executable.");
  return new Promise((resolve, reject) => {
    const child = spawn(executable.command, executable.args ?? [], { cwd: input.workDir, shell: false, windowsHide: true, signal: input.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === (input.node.expectedExitCode ?? 0) ? resolve({ stdout: stdout.trim() }) : reject(new Error(stderr || `Script exited with code ${code}.`)));
  });
}

export async function executeWorkflowV2Script(input: ExecuteWorkflowV2ScriptRequest): Promise<WorkflowV2WorkerOutput> {
  assertAuthorized(input);
  const executable = input.node.script.executable;
  const outputs = executable.kind === "command"
    ? await executeCommand(input)
    : executable.language === "typescript"
      ? await Promise.resolve(new Function("inputs", executable.code)(structuredClone(input.inputs))) as Record<string, unknown>
      : (() => { throw new Error(`Inline ${executable.language} execution is not available.`); })();
  validateOutput(input, outputs);
  return { nodeId: input.node.id, summary: `${input.node.title} completed.`, outputs, evidence: [], proposals: [] };
}
