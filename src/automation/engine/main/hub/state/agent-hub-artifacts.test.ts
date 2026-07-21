import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { listWorkflowOutputs } from "./agent-hub-artifacts";

describe("listWorkflowOutputs", () => {
  test("lists only files from the requested workflow run directory", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "workflow-outputs-"));
    const current = path.join(workDir, "outputs", "workflow-a", "run-2");
    await mkdir(current, { recursive: true });
    await mkdir(path.join(workDir, "outputs", "workflow-a", "run-1"), { recursive: true });
    await mkdir(path.join(workDir, "outputs", "workflow-b", "run-2"), { recursive: true });
    await writeFile(path.join(current, "report.md"), "current");
    await writeFile(path.join(workDir, "outputs", "workflow-a", "run-1", "old.md"), "old");
    await writeFile(path.join(workDir, "outputs", "workflow-b", "run-2", "foreign.md"), "foreign");

    const files = await listWorkflowOutputs({ workDir }, workDir, "workflow-a", "run-2");

    expect(files).toEqual([{ name: "report.md", path: path.join(current, "report.md") }]);
  });
});