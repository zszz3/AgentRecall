import { describe, expect, test } from "vitest";

import { createWorkflowV2InlineScriptSpec, type WorkflowV2AuthoredDefinition, type WorkflowV2NodeTemplate } from "./definition";
import { compileWorkflowV2Definition, createWorkflowV2TemplateRegistry } from "./templates";

describe("workflow-v2 templates", () => {
  test("compiles template-backed llm nodes into explicit executable nodes", () => {
    const templates: WorkflowV2NodeTemplate[] = [
      {
        id: "research",
        kind: "research",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Research {{params.topic}} in scope {{params.scope}}.",
        outputFields: [{ key: "summary", required: true }],
        role: "executor",
        modelProfile: "fast",
        executionLease: {
          inactivityTimeoutMs: 1_000,
          softTimeoutMs: 5_000,
          hardTimeoutMs: 10_000,
          progressProbeTimeoutMs: 500,
          maxExtensions: 1,
          maxExtensionMs: 1_000,
        },
      },
    ];
    const authored: WorkflowV2AuthoredDefinition = {
      workflowId: "wf-v2",
      graphVersion: 1,
      objective: "Research a topic",
      nodes: [
        {
          id: "n1",
          templateId: "research",
          params: { topic: "workflow v2", scope: ["design", "execution"] },
          overrides: {
            title: "Targeted Research",
            prompt: "{{templatePrompt}}\nReturn only structured output.",
          },
        },
      ],
      edges: [],
    };

    const compiled = compileWorkflowV2Definition(authored, createWorkflowV2TemplateRegistry(templates));

    expect(compiled.nodes).toEqual([
      {
        id: "n1",
        kind: "research",
        title: "Targeted Research",
        execModel: "llm",
        executionMode: "one-shot",
        outputFields: [{ key: "summary", required: true }],
        role: "executor",
        modelProfile: "fast",
        executionLease: {
          inactivityTimeoutMs: 1_000,
          softTimeoutMs: 5_000,
          hardTimeoutMs: 10_000,
          progressProbeTimeoutMs: 500,
          maxExtensions: 1,
          maxExtensionMs: 1_000,
        },
        prompt: "Research workflow v2 in scope design, execution.\nReturn only structured output.",
      },
    ]);
  });

  test("compiles template-backed script nodes with rendered code", () => {
    const templates: WorkflowV2NodeTemplate[] = [
      {
        id: "json-export",
        kind: "export",
        execModel: "script",
        executionMode: "script",
        script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "console.log('{{params.payload}}')" }),
        outputFields: [{ key: "artifact", required: true }],
      },
    ];

    const compiled = compileWorkflowV2Definition(
      {
        workflowId: "wf-v2",
        graphVersion: 1,
        objective: "Render a script",
        nodes: [{ id: "n1", templateId: "json-export", params: { payload: "ok" } }],
        edges: [],
      },
      createWorkflowV2TemplateRegistry(templates),
    );

    expect(compiled.nodes[0]).toMatchObject({
      id: "n1",
      execModel: "script",
        executionMode: "script",
      script: { executable: { kind: "inline", language: "typescript", code: "console.log('ok')" } },
    });
  });

  test("composes template hooks before user override hooks without replacing either source", () => {
    const templates: WorkflowV2NodeTemplate[] = [{
      id: "hooked",
      kind: "worker",
      execModel: "llm",
        executionMode: "one-shot",
      prompt: "Run {{params.topic}}.",
      outputFields: [{ key: "result", required: true }],
      hooks: {
        beforeExecute: [{ kind: "setVariable", config: { key: "template", value: true } }],
      },
    }];

    const compiled = compileWorkflowV2Definition({
      workflowId: "wf-v2-hooks",
      graphVersion: 1,
      objective: "Compile hooks",
      nodes: [{
        id: "n1",
        templateId: "hooked",
        params: { topic: "hooks" },
        overrides: {
          hooks: { beforeExecute: [{ kind: "injectContext", config: { text: "user context" } }] },
        },
      }],
      edges: [],
    }, createWorkflowV2TemplateRegistry(templates));

    expect(compiled.nodes[0]?.hooks?.beforeExecute).toEqual([
      expect.objectContaining({ kind: "setVariable", source: "template" }),
      expect.objectContaining({ kind: "injectContext", source: "user" }),
    ]);
  });
});
