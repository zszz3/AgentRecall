import { describe, expect, test } from "vitest";
import {
  createWorkflowV2HookRegistry,
  runWorkflowV2HookChain,
  WorkflowV2HookRegistry,
  WorkflowV2HookSignal,
} from "./workflow-v2-hooks";

const context = {
  workflowId: "workflow-1",
  runId: "run-1",
  nodeId: "node-1",
  runContext: "approved context",
};

describe("workflow-v2 hook runtime", () => {
  test("runs hooks sequentially and accumulates variables and injected context", async () => {
    const result = await runWorkflowV2HookChain({
      hooks: {
        beforeExecute: [
          { kind: "setVariable", config: { key: "scope", value: "workspace" } },
          { kind: "injectContext", config: { fromVariable: "scope" } },
        ],
      },
      lifecycle: "beforeExecute",
      context,
      registry: createWorkflowV2HookRegistry(),
    });

    expect(result.variables).toEqual({ scope: "workspace" });
    expect(result.injectedContext).toEqual(["workspace"]);
    expect(result.records.map((record) => record.kind)).toEqual(["setVariable", "injectContext"]);
  });

  test("applies fail, pause, and skip-hook policies explicitly", async () => {
    const hooks = { afterOutput: [{ kind: "writeMemory" as const, config: { key: "x", value: 1 } }] };
    await expect(runWorkflowV2HookChain({ hooks, lifecycle: "afterOutput", context, registry: createWorkflowV2HookRegistry() }))
      .rejects.toThrow("failed during afterOutput");
    await expect(runWorkflowV2HookChain({
      hooks: { afterOutput: [{ ...hooks.afterOutput[0]!, failurePolicy: "pause_run" }] },
      lifecycle: "afterOutput",
      context,
      registry: createWorkflowV2HookRegistry(),
    })).rejects.toBeInstanceOf(WorkflowV2HookSignal);
    const skipped = await runWorkflowV2HookChain({
      hooks: { afterOutput: [{ ...hooks.afterOutput[0]!, failurePolicy: "skip_hook" }] },
      lifecycle: "afterOutput",
      context,
      registry: createWorkflowV2HookRegistry(),
    });
    expect(skipped.records).toContainEqual(expect.objectContaining({ kind: "writeMemory", status: "skipped" }));
  });

  test("keeps llmHook read-only and variable-only", async () => {
    const registry = createWorkflowV2HookRegistry({
      runReadOnlyLlm: async ({ context: hookContext }) => ({ risk: hookContext.output?.risks?.[0] ?? "none" }),
    });
    const result = await runWorkflowV2HookChain({
      hooks: {
        afterOutput: [{
          kind: "llmHook",
          config: { readOnly: true, modelProfile: "fast", prompt: "Extract risk.", outputVariable: "risk" },
        }],
      },
      lifecycle: "afterOutput",
      context: {
        ...context,
        output: { nodeId: "node-1", summary: "done", outputs: {}, risks: ["high"], proposals: [] },
      },
      registry,
    });
    expect(result.variables).toEqual({ risk: { risk: "high" } });
  });

  test("rejects custom handlers that attempt to smuggle graph semantics", async () => {
    const registry = new WorkflowV2HookRegistry();
    registry.register({
      kind: "setVariable",
      allowedLifecycles: ["beforeExecute"],
      handler: async () => ({ nextNodeId: "deploy" } as unknown as { variables: Record<string, unknown> }),
    });
    await expect(runWorkflowV2HookChain({
      hooks: { beforeExecute: [{ kind: "setVariable", config: { key: "safe", value: true } }] },
      lifecycle: "beforeExecute",
      context,
      registry,
    })).rejects.toThrow("forbidden field");
  });
});
