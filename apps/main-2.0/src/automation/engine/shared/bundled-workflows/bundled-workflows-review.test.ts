import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { WorkflowV2Definition } from "../workflow-v2/definition";
import { validateWorkflowV2Definition } from "../workflow-v2/validation";

const workflowNames = ["github-daily-ai", "resume", "job-tailored-resume", "code-change-review"];

describe("official Workflow Review configuration", () => {
  test.each(workflowNames)("keeps %s disabled by default with valid critical-node criteria", (name) => {
    const sourcePath = new URL(`./${name}/workflow.json`, import.meta.url);
    const assetPath = new URL(`../../../../../assets/automation/bundled-workflows/${name}/workflow.json`, import.meta.url);
    const source = readFileSync(sourcePath, "utf8");
    const bundled = JSON.parse(source) as { definition: WorkflowV2Definition };
    expect(readFileSync(assetPath, "utf8")).toBe(source);
    expect(bundled.definition.reviewEnabled).toBe(false);
    expect(validateWorkflowV2Definition(bundled.definition)).toMatchObject({ valid: true, errors: [] });
    const reviewedNodes = bundled.definition.nodes.filter((node) => node.reviewLevel && node.reviewLevel !== "none");
    expect(reviewedNodes.length).toBeGreaterThan(0);
    expect(reviewedNodes.every((node) => node.execModel === "llm")).toBe(true);
    expect(reviewedNodes.every((node) => node.judgeDimensions?.length && node.reviewMaxRetries === 2)).toBe(true);
    if (name === "code-change-review") {
      const collectChanges = bundled.definition.nodes.find((node) => node.id === "collect_changes" && node.execModel === "script");
      expect(collectChanges?.execModel).toBe("script");
      if (!collectChanges || collectChanges.execModel !== "script") throw new Error("collect_changes must be a script node");
      expect(collectChanges?.script?.effectMode).toBe("workspace_only");
      expect(collectChanges?.script?.capabilities).toEqual(expect.arrayContaining(["workspace_read", "process_spawn", "shell_execute"]));
      expect(collectChanges?.script?.executable.kind === "inline" ? collectChanges.script.executable.code : "").toContain("StringDecoder");
      expect(collectChanges).not.toHaveProperty("reviewLevel");
      expect(collectChanges).not.toHaveProperty("reviewMaxRetries");
      expect(collectChanges).not.toHaveProperty("judgeDimensions");
    }
  });
});
