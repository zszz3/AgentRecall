import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { WorkflowV2ScriptNode } from "../../../../shared/workflow-v2/definition";
import { WorkflowScriptNodePanel } from "./WorkflowScriptNodePanel";

const node: WorkflowV2ScriptNode = {
  id: "echo",
  kind: "transform",
  title: "Echo input",
  execModel: "script",
  executionMode: "script",
  script: {
    executable: { kind: "inline", language: "typescript", code: "return { echoed: inputs.text };" },
    parameters: [
      { key: "text", label: "Text", location: "stdin", valueType: "string", source: "user", required: true },
      { key: "prefix", label: "Prefix", location: "environment", valueType: "string", source: "literal", required: false, literalValue: "value:" },
    ],
    capabilities: [],
    managerRisk: { level: "safe", rationale: "Pure transform." },
    outputSchema: { type: "object", required: ["echoed"] },
  },
  outputFields: [{ key: "echoed", required: true }],
};

describe("WorkflowScriptNodePanel", () => {
  test("exposes script contents for manual editing when the definition is editable", () => {
    const html = renderToStaticMarkup(<WorkflowScriptNodePanel node={node} editable onUpdateNode={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("Script node · editable");
    expect(html).toContain("return { echoed: inputs.text };");
    expect(html).toContain("Edit script");
  });

  test("shows script code and variable bindings without agent conversation chrome", () => {
    const html = renderToStaticMarkup(<WorkflowScriptNodePanel node={node} onClose={() => undefined} />);
    expect(html).toContain('aria-label="Echo input script details"');
    expect(html).toContain("return { echoed: inputs.text };");
    expect(html).toContain("Input variables");
    expect(html).toContain("User input");
    expect(html).toContain("Literal");
    expect(html).toContain("Output fields");
    expect(html).not.toContain("Node conversations");
    expect(html).not.toContain("Send information to this node agent");
  });

  test("renders typed user inputs inside the script surface", () => {
    const html = renderToStaticMarkup(<WorkflowScriptNodePanel
      node={node}
      progress={{ nodeId: "echo", title: "Echo input", status: "awaiting_input", inputRequest: { kind: "script_parameters", parameters: [node.script.parameters[0]!] } }}
      onSubmitInput={() => undefined}
      onClose={() => undefined}
    />);
    expect(html).toContain("Required run inputs");
    expect(html).toContain("Run script");
    expect(html).toContain('name="text"');
  });

  test("organizes multiple request inputs into Apifox-style tabs and renders enums as selects", () => {
    const html = renderToStaticMarkup(<WorkflowScriptNodePanel
      node={node}
      progress={{ nodeId: "echo", title: "Echo input", status: "awaiting_input", inputRequest: { kind: "script_parameters", parameters: [
        { key: "q", label: "Query", location: "query", valueType: "string", source: "user", required: true },
        { key: "mode", label: "Mode", location: "query", valueType: "string", source: "user", required: true, enum: ["fast", "safe"] },
        { key: "authorization", label: "Authorization", location: "header", valueType: "string", source: "user", required: false },
        { key: "format", label: "Format", location: "body", valueType: "string", source: "user", required: true, enum: ["json", "text"] },
      ] } }}
      onSubmitInput={() => undefined}
      onClose={() => undefined}
    />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain(">Params<");
    expect(html).toContain(">Headers<");
    expect(html).toContain(">Body<");
    expect(html).toContain('name="mode"');
    expect(html).toContain('<option value="fast">fast</option>');
  });

  test("renders completed script output as structured JSON", () => {
    const html = renderToStaticMarkup(<WorkflowScriptNodePanel
      node={node}
      progress={{ nodeId: "echo", title: "Echo input", status: "completed", outputs: { echoed: "hello", count: 1 } }}
      onClose={() => undefined}
    />);
    expect(html).toContain("The values returned by this script node.");
    expect(html).toContain('&quot;echoed&quot;: &quot;hello&quot;');
    expect(html).toContain('&quot;count&quot;: 1');
  });

  test("renders an informed approve-once and reject surface for dangerous execution", () => {
    const html = renderToStaticMarkup(<WorkflowScriptNodePanel
      node={node}
      progress={{
        nodeId: "echo",
        title: "Echo input",
        status: "paused",
        intervention: {
          nodeId: "echo",
          source: "script_permission",
          reason: "External command execution is dynamic and fails closed.",
          allowedActions: ["approve_once", "reject"],
          requestedAt: 1,
          scriptApproval: {
            requestId: "approval-1",
            risk: "dangerous",
            capabilities: ["process_spawn", "shell_execute"],
            capabilityDigest: "capability-digest",
            operationDigest: "operation-digest",
            executableSummary: "tool --delete temp",
            workDir: "C:/workspace",
          },
        },
      }}
      onResolveApproval={() => undefined}
      onClose={() => undefined}
    />);

    expect(html).toContain("Dangerous operation requires approval");
    expect(html).toContain("approval-1");
    expect(html).toContain("process_spawn, shell_execute");
    expect(html).toContain("tool --delete temp");
    expect(html).toContain("Approve once");
    expect(html).toContain("Reject");
  });
});
