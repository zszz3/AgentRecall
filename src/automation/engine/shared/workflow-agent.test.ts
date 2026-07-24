import { describe, expect, test } from "vitest";
import {
  buildWorkflowAgentPrompt,
  buildWorkflowRevisionPrompt,
  firstWorkflowQuestionForObjective,
  nextWorkflowQuestion,
  WORKFLOW_FOLLOW_UP_QUESTIONS,
  WORKFLOW_V2_DEFINITION_TEMPLATE,
} from "./workflow-agent";

describe("workflow V2 manager prompt", () => {
  test("requires V2 creation and correct interaction classification", () => {
    const prompt = buildWorkflowAgentPrompt({ workflowId: "wf-fixed", objective: "Determine the user's mood from user input" });
    expect(prompt).toContain("Workflow V2 Manager");
    expect(prompt).toContain("workflow_create");
    expect(prompt).toContain("wf-fixed");
    expect(prompt).toContain("workflowId: must be exactly");
    expect(prompt).toContain("WorkflowV2Definition");
    expect(prompt).toContain("typed user parameters must remain a script node");
    expect(prompt).toContain("Only add an interactive LLM node when collecting the input itself requires natural-language reasoning, clarification, iteration, choice, or confirmation");
    expect(prompt).toContain("Never classify an input-dependent node as one-shot");
    expect(prompt).toContain("Use script nodes for deterministic parsing");
    expect(prompt).toContain("echoing, copying, mapping, serialization, and passing values through unchanged");
    expect(prompt).toContain("Do not add an interactive LLM node merely to collect typed parameters for a script");
    expect(prompt).toContain("Do not invent a choice between strict script behavior and immediate executability");
    expect(prompt).toContain("Do not ask the user to choose output field names");
    expect(prompt).toContain("A request to return exactly what the user enters is already complete");
    expect(prompt).toContain("Do not use memory, skills, or repository history to override these runtime rules");
    expect(prompt).toContain("Build the smallest graph");
    expect(prompt).toContain("Every script input must be declared exactly once");
    expect(prompt).toContain("declare source=upstream");
    expect(prompt).toContain("upstreamOutputKey to an exact key declared by the predecessor's outputFields");
    expect(prompt).toContain("Downstream bindings read outputs[upstreamOutputKey], never the LLM summary");
    expect(prompt).toContain("declare the output field valueType");
    expect(prompt).toContain('"artifact":{"format":"markdown","fileName":"report.md"}');
    expect(prompt).toContain("Use valueType=file only when the node itself creates a file");
    expect(prompt).toContain('"upstreamNodeId":"research"');
    expect(prompt).toContain('"valueType":"string"');
    expect(prompt).toContain("Read values through inputs.<key>");
    expect(prompt).toContain("Do not read WORKFLOW_INPUT");
    expect(prompt).toContain("Classify pure in-memory transformations as safe");
  });

  test("provides a valid-shape V2 definition example", () => {
    const definition = JSON.parse(WORKFLOW_V2_DEFINITION_TEMPLATE);
    expect(definition).toMatchObject({ graphVersion: 1, nodes: [{ execModel: "script", executionMode: "script", script: { parameters: [{ source: "user" }], managerRisk: { level: "safe" } } }] });
    expect(definition.nodes).toHaveLength(1);
    expect(definition.edges).toEqual([]);
    expect(definition.nodes.some((node: { kind: string }) => node.kind === "start" || node.kind === "end")).toBe(false);
    expect(definition.nodes[0].script.executable.code).toContain("inputs.text");
    expect(definition.nodes[0].script.executable.code).not.toContain("WORKFLOW_INPUT");
  });

  test("treats a fully specified echo request as immediately creatable", () => {
    const prompt = buildWorkflowAgentPrompt({ workflowId: "wf-echo", objective: "Return exactly what the user enters" });
    expect(prompt).toContain("do not ask another planning question");
    expect(prompt).toContain("one script node with a required source=user string parameter");
    expect(prompt).toContain('"execModel": "script"');
    expect(prompt).not.toContain("generic echo scripts are unsupported");
  });

  test("questions include a recommended answer", () => {
    expect(firstWorkflowQuestionForObjective("review a repository")).toContain("structured script parameters");
    for (let index = 0; index < WORKFLOW_FOLLOW_UP_QUESTIONS.length; index += 1) {
      expect(nextWorkflowQuestion(index + 1)).toContain("Recommended answer");
    }
  });

  test("grounds post-generation changes in the current workflow revision", () => {
    const prompt = buildWorkflowRevisionPrompt({ workflowId: "wf-edit", revision: 7, definition: { workflowId: "wf-edit", graphVersion: 3, nodes: [{ id: "answer" }], edges: [] }, request: "Make the answer shorter" });
    expect(prompt).toContain("wf-edit");
    expect(prompt).toContain("revision 7");
    expect(prompt).toContain("workflow_create");
    expect(prompt).toContain('"graphVersion": 3');
    expect(prompt).toContain("Make the answer shorter");
  });
});
