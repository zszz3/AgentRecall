import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const rendererFiles = [
  "../../app/services/workflow-service.ts",
  "./workflow-controller.ts",
  "./hooks/useWorkflowFeatureController.ts",
  "./workflow-text.ts",
];

const currentDir = fileURLToPath(new URL(".", import.meta.url));

describe("workflow input ownership", () => {
  test("removes the legacy gate chain while retaining the typed intervention boundary", () => {
    const source = rendererFiles
      .map((file) => readFileSync(resolve(currentDir, file), "utf8"))
      .join("\n");

    expect(source).toMatch(/onResolveIntervention|resolveIntervention/);
    expect(source).not.toMatch(/onAnswerGate|answerGate/);
    expect(source).not.toMatch(/gateAnswerPlaceholder|gateSubmit|workflow-gate-panel/);
  });
});
