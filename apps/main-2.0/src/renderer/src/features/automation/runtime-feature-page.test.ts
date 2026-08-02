import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { ConfiguredAgent } from "../../../../automation/contracts";
import { reconcileEditableAgentsAfterChannelSave } from "./runtime-feature-page";

const automationStyles = readFileSync(new URL("../../styles/automation.css", import.meta.url), "utf8");

function agent(id: string, managed = false): ConfiguredAgent {
  return {
    id,
    name: id,
    description: "",
    runtimeAgentId: "codex",
    channelId: id === "generated" ? "new-channel" : "codex-openai",
    modelId: "default",
    tags: [],
    ...(managed ? { managed: true } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("reconcileEditableAgentsAfterChannelSave", () => {
  test("keeps local edits and appends Agent generated for a new execution config", () => {
    const previous = [agent("default", true), agent("edited")];
    const edited = [{ ...agent("edited"), name: "Edited locally" }];

    expect(reconcileEditableAgentsAfterChannelSave(edited, previous, [...previous, agent("generated", true)]))
      .toEqual([...edited, agent("generated", true)]);
  });

  test("does not restore a previously known managed Agent deleted by the user", () => {
    const previous = [agent("default", true)];
    expect(reconcileEditableAgentsAfterChannelSave([], previous, previous)).toEqual([]);
  });
});

describe("Runtime execution config layout", () => {
  test("keeps the detail editor scrollable inside the bounded workspace", () => {
    const layoutRule = automationStyles.match(/\.automation-runtime-content \.runtime-layout\s*\{([^}]*)\}/)?.[1];
    const workspaceRule = automationStyles.match(/\.automation-runtime-content \.runtime-config-workspace\s*\{([^}]*)\}/)?.[1];
    const editorRule = automationStyles.match(/\.automation-runtime-content \.runtime-editor\s*\{([^}]*)\}/)?.[1];

    expect(layoutRule).toContain("overflow: hidden");
    expect(workspaceRule).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(workspaceRule).toContain("overflow: hidden");
    expect(editorRule).toContain("min-height: 0");
    expect(editorRule).toContain("grid-auto-rows: max-content");
    expect(editorRule).toContain("overflow-y: auto");
  });
});
