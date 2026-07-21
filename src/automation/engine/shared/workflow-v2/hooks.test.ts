import { describe, expect, test } from "vitest";
import {
  composeWorkflowV2NodeHooks,
  resolveWorkflowV2HookActions,
  workflowV2NodeHookValidationErrors,
} from "./hooks";

describe("workflow-v2 hook contracts", () => {
  test("composes template, node, and user hooks in stable precedence order", () => {
    const hooks = composeWorkflowV2NodeHooks({
      template: { beforeExecute: [{ kind: "setVariable", config: { key: "template", value: 1 } }] },
      node: { beforeExecute: [{ kind: "injectContext", config: { text: "node context" } }] },
      user: { beforeExecute: [{ kind: "pause", config: { reason: "confirm" } }] },
    });

    expect(resolveWorkflowV2HookActions(hooks, "beforeExecute").map(({ kind, source, order }) => ({ kind, source, order }))).toEqual([
      { kind: "setVariable", source: "template", order: 0 },
      { kind: "injectContext", source: "node", order: 1 },
      { kind: "pause", source: "user", order: 2 },
    ]);
  });

  test("requires llmHook to stay read-only, fast, bounded, and variable-producing", () => {
    expect(workflowV2NodeHookValidationErrors({
      afterOutput: [{
        kind: "llmHook",
        config: { readOnly: true, modelProfile: "fast", prompt: "Extract risk labels.", outputVariable: "risk.labels" },
      }],
    })).toEqual([]);
    expect(workflowV2NodeHookValidationErrors({
      afterOutput: [{ kind: "llmHook", config: { readOnly: false, modelProfile: "expert", prompt: "", outputVariable: "bad key" } }],
    }).join(" ")).toContain("readOnly=true");
  });

  test("rejects hidden routing and review semantics recursively", () => {
    expect(workflowV2NodeHookValidationErrors({
      beforeExecute: [{ kind: "setVariable", config: { key: "route", value: { nextNodeId: "deploy" } } }],
    })).toEqual([
      "hooks.beforeExecute[0] config cannot contain routing or review field config.value.nextNodeId.",
    ]);
  });

  test("makes failure policy and lifecycle restrictions explicit", () => {
    expect(workflowV2NodeHookValidationErrors({
      afterComplete: [{ kind: "skip", failurePolicy: "sometimes" }],
    })).toEqual([
      "hooks.afterComplete[0] skip is not allowed during afterComplete.",
      "hooks.afterComplete[0] has an invalid failure policy.",
    ]);
  });

  test("uses one explicit lifecycle matrix for every action", () => {
    expect(workflowV2NodeHookValidationErrors({
      beforeExecute: [{ kind: "writeFile", config: { path: "result.txt", value: "done" } }],
      afterOutput: [{ kind: "injectContext", config: { text: "too late" } }],
    })).toEqual([
      "hooks.beforeExecute[0] writeFile is not allowed during beforeExecute.",
      "hooks.afterOutput[0] injectContext is not allowed during afterOutput.",
    ]);
  });

  test("validates action-specific configuration before runtime", () => {
    expect(workflowV2NodeHookValidationErrors({
      afterOutput: [
        { kind: "writeMemory", config: { key: "result", value: 1, fromVariable: "result" } },
        { kind: "writeFile", config: { path: "../outside.txt", value: "unsafe" } },
        { kind: "readMemory", config: { key: "", outputVariable: "bad key" } },
        { kind: "pause", config: { reason: "ok", arbitrary: true } },
      ],
    }).join(" ")).toContain("requires exactly one of value or fromVariable");
    expect(workflowV2NodeHookValidationErrors({
      afterOutput: [{ kind: "writeFile", config: { path: "../outside.txt", value: "unsafe" } }],
    }).join(" ")).toContain("safe relative path");
    expect(workflowV2NodeHookValidationErrors({
      afterOutput: [{ kind: "pause", config: { reason: "ok", arbitrary: true } }],
    }).join(" ")).toContain("unsupported field config.arbitrary");
  });
});
