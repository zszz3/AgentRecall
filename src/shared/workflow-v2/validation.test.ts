import { describe, expect, test } from "vitest";

import type {
  WorkflowV2AuthoredDefinition,
  WorkflowV2Definition,
  WorkflowV2NodeTemplate,
  WorkflowV2ScriptLanguage,
} from "./definition";
import { createWorkflowV2TemplateRegistry } from "./templates";
import {
  compileAndValidateWorkflowV2Definition,
  validateWorkflowV2ConfiguredAgentReferences,
  validateWorkflowV2Definition,
} from "./validation";

function validDefinition(): WorkflowV2Definition {
  return {
    workflowId: "wf-v2",
    graphVersion: 1,
    objective: "Implement workflow v2 authoring",
    nodes: [
      {
        id: "plan",
        kind: "plan",
        title: "Plan",
        execModel: "llm",
        executionMode: "one-shot",
        role: "orchestrator",
        outputFields: [{ key: "plan", required: true }],
        prompt: "Create the implementation plan.",
      },
      {
        id: "apply",
        kind: "apply",
        title: "Apply",
        execModel: "script",
        executionMode: "script",
        role: "executor",
        outputFields: [{ key: "result", required: true }],
        script: {
          executable: { kind: "inline", language: "bash", code: "echo ok" },
          parameters: [],
          capabilities: [],
          managerRisk: { level: "safe", rationale: "Returns a constant value." },
        },
      },
    ],
    edges: [{ fromNodeId: "plan", toNodeId: "apply" }],
  };
}

describe("workflow-v2 validation", () => {
  test("rejects node Agent references that are absent from the configured Agent catalog", () => {
    const definition = validDefinition();
    const node = definition.nodes[0]!;
    if (node.execModel !== "llm") throw new Error("Expected llm fixture node");
    node.configuredAgentId = "missing-agent";
    expect(validateWorkflowV2ConfiguredAgentReferences(definition, ["default-agent"])).toEqual([
      "Workflow V2 configured agent missing-agent was not found.",
    ]);
  });

  test("rejects empty per-node agent routing fields", () => {
    const definition = validDefinition();
    const node = definition.nodes[0]!;
    if (node.execModel !== "llm") throw new Error("expected llm node");
    node.configuredAgentId = "";
    node.modelId = "";
    expect(validateWorkflowV2Definition(definition).errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("configuredAgentId must not be empty"),
        expect.stringContaining("modelId must not be empty"),
      ]),
    );
  });

  test("accepts the canonical script contract without legacy permission fields", () => {
    const definition = validDefinition();
    definition.nodes[1] = {
      id: "apply",
      kind: "apply",
      title: "Apply",
      execModel: "script",
      executionMode: "script",
      outputFields: [{ key: "result", required: true }],
      script: {
        executable: { kind: "inline", language: "typescript", code: "return inputs;" },
        parameters: [],
        capabilities: [],
        managerRisk: { level: "safe", rationale: "Pure in-memory transform." },
      },
    };

    expect(validateWorkflowV2Definition(definition)).toMatchObject({ valid: true, errors: [] });
  });

  test("accepts a valid compiled definition", () => {
    const result = validateWorkflowV2Definition(validDefinition());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.topologicalNodeIds).toEqual(["plan", "apply"]);
  });

  test("rejects definitions with multiple terminal nodes", () => {
    const invalid = validDefinition();
    invalid.edges = [];

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Workflow V2 definition must have exactly one terminal node, found 2.",
    );
  });

  test("rejects nodes that omit execution mode", () => {
    const invalid = validDefinition();
    delete invalid.nodes[0]!.executionMode;

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Workflow V2 node plan must declare execution mode explicitly.",
    );
  });

  test("rejects execution modes incompatible with the node execution model", () => {
    const invalid = validDefinition();
    invalid.nodes[0]!.executionMode = "script";
    invalid.nodes[1]!.executionMode = "interactive";

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Workflow V2 llm node plan cannot use script execution mode.",
        "Workflow V2 script node apply must use script execution mode.",
      ]),
    );
  });

  test("rejects execution mode confidence outside zero to one", () => {
    const invalid = validDefinition();
    invalid.nodes[0]!.executionModeConfidence = 1.5;

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Workflow V2 node plan execution mode confidence must be between 0 and 1.",
    );
  });

  test("accepts a negative safe integer expected exit code", () => {
    const definition = validDefinition();
    const node = definition.nodes[1]!;
    if (node.execModel !== "script") throw new Error("expected script node");
    node.expectedExitCode = -1;

    expect(validateWorkflowV2Definition(definition).valid).toBe(true);
  });

  test("validates enum request parameters as typed, non-empty, and unique", () => {
    const definition = validDefinition();
    const node = definition.nodes[1]!;
    if (node.execModel !== "script") throw new Error("expected script node");
    node.script.parameters = [
      {
        key: "format",
        label: "Format",
        location: "query",
        valueType: "string",
        source: "user",
        required: true,
        enum: ["json", "text"],
      },
    ];
    expect(validateWorkflowV2Definition(definition).valid).toBe(true);

    node.script.parameters[0]!.enum = ["json", "json"];
    expect(validateWorkflowV2Definition(definition).errors).toContain(
      "Workflow V2 script node apply parameter format has duplicate enum values.",
    );
  });

  test("accepts a script parameter bound to a declared direct upstream output", () => {
    const definition = validDefinition();
    definition.nodes[0]!.outputFields[0]!.valueType = "string";
    const node = definition.nodes[1]!;
    if (node.execModel !== "script") throw new Error("expected script node");
    node.script.parameters = [
      {
        key: "plan",
        label: "Plan",
        location: "body",
        valueType: "string",
        source: "upstream",
        required: true,
        upstreamNodeId: "plan",
        upstreamOutputKey: "plan",
      },
    ];

    expect(validateWorkflowV2Definition(definition)).toMatchObject({ valid: true, errors: [] });
  });

  test("rejects incomplete or invalid upstream script parameter bindings", () => {
    const definition = validDefinition();
    const node = definition.nodes[1]!;
    if (node.execModel !== "script") throw new Error("expected script node");
    node.script.parameters = [
      {
        key: "missingBinding",
        label: "Missing binding",
        location: "body",
        valueType: "string",
        source: "upstream",
        required: true,
      },
      {
        key: "missingNode",
        label: "Missing node",
        location: "body",
        valueType: "string",
        source: "upstream",
        required: true,
        upstreamNodeId: "unknown",
        upstreamOutputKey: "plan",
      },
      {
        key: "missingOutput",
        label: "Missing output",
        location: "body",
        valueType: "string",
        source: "upstream",
        required: true,
        upstreamNodeId: "plan",
        upstreamOutputKey: "unknown",
      },
    ];

    const result = validateWorkflowV2Definition(definition);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Workflow V2 script node apply upstream parameter missingBinding must declare upstreamNodeId.",
        "Workflow V2 script node apply upstream parameter missingBinding must declare upstreamOutputKey.",
        "Workflow V2 script node apply upstream parameter missingNode references missing node unknown.",
        "Workflow V2 script node apply upstream parameter missingOutput references output unknown, which is not declared by node plan.",
      ]),
    );
  });

  test("rejects an upstream binding to a node that is not a direct predecessor", () => {
    const definition = validDefinition();
    const node = definition.nodes[1]!;
    if (node.execModel !== "script") throw new Error("expected script node");
    node.script.parameters = [
      {
        key: "plan",
        label: "Plan",
        location: "body",
        valueType: "string",
        source: "upstream",
        required: true,
        upstreamNodeId: "plan",
        upstreamOutputKey: "plan",
      },
    ];
    definition.edges = [];

    expect(validateWorkflowV2Definition(definition).errors).toContain(
      "Workflow V2 script node apply upstream parameter plan must reference a direct upstream node, but plan is not connected to apply.",
    );
  });

  test("rejects an upstream output type that does not match the consuming script parameter", () => {
    const definition = validDefinition();
    definition.nodes[0]!.outputFields[0]!.valueType = "number";
    const node = definition.nodes[1]!;
    if (node.execModel !== "script") throw new Error("expected script node");
    node.script.parameters = [
      {
        key: "plan",
        label: "Plan",
        location: "body",
        valueType: "string",
        source: "upstream",
        required: true,
        upstreamNodeId: "plan",
        upstreamOutputKey: "plan",
      },
    ];

    expect(validateWorkflowV2Definition(definition).errors).toContain(
      "Workflow V2 node plan output field plan has value type number, but script node apply parameter plan requires string.",
    );
  });

  test("returns structured errors for an unsupported execution model instead of throwing", () => {
    const invalid = validDefinition();
    invalid.nodes[0]!.execModel = "tool" as unknown as typeof invalid.nodes[0]["execModel"];

    expect(() => validateWorkflowV2Definition(invalid)).not.toThrow();
    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow V2 node plan has unsupported execution model tool.");
  });

  test("rejects an unsupported script language from an untrusted caller", () => {
    const invalid = validDefinition();
    const node = invalid.nodes[1]!;
    if (node.execModel !== "script" || node.script.executable.kind !== "inline") {
      throw new Error("expected inline script node");
    }
    node.script.executable.language = "powershell" as unknown as WorkflowV2ScriptLanguage;

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Workflow V2 script node apply has unsupported language powershell.",
    );
  });

  test("rejects an explicit unsupported node role from an untrusted caller", () => {
    const invalid = validDefinition();
    invalid.nodes[0]!.role = "admin" as unknown as NonNullable<typeof invalid.nodes[0]["role"]>;

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow V2 node plan has unsupported role admin.");
  });

  test("rejects an unsupported llm model profile from an untrusted caller", () => {
    const invalid = validDefinition();
    const node = invalid.nodes[0]!;
    if (node.execModel !== "llm") throw new Error("expected llm node");
    node.modelProfile = "turbo" as unknown as NonNullable<typeof node.modelProfile>;

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Workflow V2 llm node plan has unsupported model profile turbo.",
    );
  });

  test("rejects duplicate directed edges", () => {
    const invalid = validDefinition();
    invalid.edges.push({ fromNodeId: "plan", toNodeId: "apply" });

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow V2 definition has duplicate edge plan -> apply.");
  });

  test.each([
    ["non-finite", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s graphVersion", (_name, graphVersion) => {
    const invalid = { ...validDefinition(), graphVersion };

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Workflow V2 definition must have a positive safe-integer graphVersion.",
    );
  });

  test("rejects duplicate ids, missing node references, and cycles", () => {
    const base = validDefinition();
    const invalid: WorkflowV2Definition = {
      ...base,
      nodes: [base.nodes[0]!, { ...base.nodes[1]!, id: "plan" }],
      edges: [
        { fromNodeId: "plan", toNodeId: "missing" },
        { fromNodeId: "plan", toNodeId: "plan" },
      ],
    };

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow V2 definition has duplicate node id plan.");
    expect(result.errors).toContain("Workflow V2 edge plan -> missing references a missing node.");
    expect(result.errors).toContain("Workflow V2 definition must be acyclic.");
  });

  test("rejects nodes with missing execution details", () => {
    const invalid: WorkflowV2Definition = {
      workflowId: "wf-v2",
      graphVersion: 1,
      objective: "Broken",
      nodes: [
        {
          id: "llm-node",
          kind: "review",
          title: "Review",
          execModel: "llm",
          executionMode: "one-shot",
          outputFields: [],
          prompt: "",
        },
        {
          id: "script-node",
          kind: "transform",
          title: "Transform",
          execModel: "script",
          executionMode: "script",
          outputFields: [{ key: "artifact" }],
          script: {
            executable: { kind: "inline", language: "python", code: "" },
            parameters: [],
            capabilities: [],
            managerRisk: { level: "safe", rationale: "Pure transform." },
          },
          expectedExitCode: 1.2 as unknown as number,
        },
      ],
      edges: [],
    };

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Workflow V2 node llm-node must declare at least one output field.",
    );
    expect(result.errors).toContain("Workflow V2 llm node llm-node must have a prompt.");
    expect(result.errors).toContain("Workflow V2 script node script-node must have executable code.");
    expect(result.errors).toContain(
      "Workflow V2 script node script-node must have a safe-integer expectedExitCode.",
    );
  });

  test.each([
    ["non-finite", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects an llm node with a %s maxRetry", (_name, maxRetry) => {
    const invalid = validDefinition();
    const node = invalid.nodes[0]!;
    if (node.execModel !== "llm") throw new Error("expected llm node");
    node.maxRetry = maxRetry;

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Workflow V2 llm node plan must have a non-negative safe-integer maxRetry.",
    );
  });

  test.each([
    ["non-safe maxContextTokens", { maxContextTokens: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative maxEvidenceItems", { maxContextTokens: 1_000, maxEvidenceItems: -1 }],
    ["non-finite maxUpstreamNodes", { maxContextTokens: 1_000, maxUpstreamNodes: Number.NaN }],
    ["unsupported summaryFallbackPolicy", { maxContextTokens: 1_000, summaryFallbackPolicy: "drop" }],
  ])("rejects an llm node with %s", (_name, contextBudget) => {
    const invalid = validDefinition();
    const node = invalid.nodes[0]!;
    if (node.execModel !== "llm") throw new Error("expected llm node");
    node.contextBudget = contextBudget as NonNullable<typeof node.contextBudget>;

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow V2 llm node plan has an invalid context budget.");
  });

  test.each([
    ["non-finite", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["zero", 0],
  ])("rejects a script node with a %s timeout", (_name, timeoutMs) => {
    const invalid = validDefinition();
    const node = invalid.nodes[1]!;
    if (node.execModel !== "script") throw new Error("expected script node");
    node.script.timeoutMs = timeoutMs;

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Workflow V2 script node apply must have a positive safe-integer timeoutMs.",
    );
  });

  test.each([
    ["non-finite", Number.NaN],
    ["infinite", Number.NEGATIVE_INFINITY],
    ["unsafe positive", Number.MAX_SAFE_INTEGER + 1],
    ["unsafe negative", Number.MIN_SAFE_INTEGER - 1],
  ])("rejects a script node with a %s expected exit code", (_name, expectedExitCode) => {
    const invalid = validDefinition();
    const node = invalid.nodes[1]!;
    if (node.execModel !== "script") throw new Error("expected script node");
    node.expectedExitCode = expectedExitCode;

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Workflow V2 script node apply must have a safe-integer expectedExitCode.",
    );
  });

  test("accepts a bounded execution lease policy", () => {
    const definition = validDefinition();
    definition.nodes[0]!.executionLease = {
      inactivityTimeoutMs: 1_000,
      softTimeoutMs: 5_000,
      hardTimeoutMs: 10_000,
      progressProbeTimeoutMs: 500,
      maxExtensions: 2,
      maxExtensionMs: 1_000,
    };

    expect(validateWorkflowV2Definition(definition).valid).toBe(true);
  });

  test("rejects an execution lease whose soft deadline is not below its hard deadline", () => {
    const invalid = validDefinition();
    invalid.nodes[0]!.executionLease = {
      inactivityTimeoutMs: 1_000,
      softTimeoutMs: 10_000,
      hardTimeoutMs: 10_000,
      progressProbeTimeoutMs: 500,
      maxExtensions: 2,
      maxExtensionMs: 1_000,
    };

    const result = validateWorkflowV2Definition(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow V2 node plan has an invalid execution lease policy.");
  });

  test("fails fast when a template reference cannot be compiled", () => {
    const authored: WorkflowV2AuthoredDefinition = {
      workflowId: "wf-v2",
      graphVersion: 1,
      objective: "Broken template",
      nodes: [{ id: "n1", templateId: "missing-template" }],
      edges: [],
    };

    const templates: WorkflowV2NodeTemplate[] = [];
    const result = compileAndValidateWorkflowV2Definition(
      authored,
      createWorkflowV2TemplateRegistry(templates),
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["Unknown workflow-v2 template: missing-template"]);
    expect(result.topologicalNodeIds).toEqual([]);
  });
});
