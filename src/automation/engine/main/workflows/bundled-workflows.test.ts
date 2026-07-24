import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { validateWorkflowV2Definition } from "../../shared/workflow-v2/validation";
import { loadBundledWorkflows } from "./bundled-workflows";

describe("loadBundledWorkflows", () => {
  test("loads a workflow and injects the template asset into the render node", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bundled-wf-"));
    const dir = path.join(root, "resume");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "resume-template.html"), "<html>{{姓名}}</html>\n", "utf8");
    await writeFile(path.join(dir, "resume-guidelines.md"), "问题→方案→量化\n", "utf8");
    await writeFile(
      path.join(dir, "workflow.json"),
      JSON.stringify({
        id: "bundled-resume-html",
        title: "简历生成 (HTML)",
        objective: "obj",
        assets: { __RESUME_TEMPLATE__: "resume-template.html", __RESUME_GUIDE__: "resume-guidelines.md" },
        definition: {
          workflowId: "bundled-resume-html",
          graphVersion: 1,
          objective: "obj",
          nodes: [
            { id: "render", kind: "render", title: "??", execModel: "llm",
        executionMode: "one-shot", prompt: "??:\n__RESUME_GUIDE__\n??:\n__RESUME_TEMPLATE__\n??", outputFields: [] },
          ],
          edges: [],
        },
      }),
      "utf8",
    );

    const defs = await loadBundledWorkflows(root);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ workflowId: "bundled-resume-html", title: "简历生成 (HTML)" });
    const render = defs[0]?.definition.nodes.find((node): node is import("../../shared/workflow-v2/definition").WorkflowV2LLMNode => node.id === "render" && node.execModel === "llm");
    expect(render?.prompt).toContain("<html>{{姓名}}</html>");
    expect(render?.prompt).toContain("问题→方案→量化");
    expect(render?.prompt).not.toContain("__RESUME_TEMPLATE__");
    expect(render?.prompt).not.toContain("__RESUME_GUIDE__");
  });

  test("returns empty for a missing root", async () => {
    expect(await loadBundledWorkflows(path.join(os.tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });

  test("loads the code change review workflow from source and packaged assets", async () => {
    const sourceRoot = path.resolve("src/automation/engine/shared/bundled-workflows");
    const packagedRoot = path.resolve("assets/automation/bundled-workflows");
    const [sourceDefinitions, packagedDefinitions] = await Promise.all([
      loadBundledWorkflows(sourceRoot),
      loadBundledWorkflows(packagedRoot),
    ]);

    for (const definitions of [sourceDefinitions, packagedDefinitions]) {
      const review = definitions.find((definition) => definition.workflowId === "bundled-code-change-review");
      expect(review).toBeDefined();
      expect(review).toMatchObject({ title: "代码变更审查" });
      expect(validateWorkflowV2Definition(review!.definition)).toMatchObject({ valid: true, errors: [] });
      expect(review!.definition.nodes).toHaveLength(7);
      expect(review!.definition.edges).toEqual(expect.arrayContaining([
        { fromNodeId: "collect_changes", toNodeId: "impact_scope" },
        { fromNodeId: "impact_scope", toNodeId: "correctness" },
        { fromNodeId: "impact_scope", toNodeId: "security" },
        { fromNodeId: "impact_scope", toNodeId: "tests" },
        { fromNodeId: "impact_scope", toNodeId: "compatibility" },
        { fromNodeId: "impact_scope", toNodeId: "report" },
        { fromNodeId: "correctness", toNodeId: "report" },
        { fromNodeId: "security", toNodeId: "report" },
        { fromNodeId: "tests", toNodeId: "report" },
        { fromNodeId: "compatibility", toNodeId: "report" },
      ]));
      const collector = review!.definition.nodes.find((node) => node.id === "collect_changes");
      expect(collector).toMatchObject({
        execModel: "script",
        script: {
          parameters: [{
            key: "review_directory",
            valueType: "directory",
            source: "user",
            required: true,
          }],
          capabilities: ["workspace_read", "process_spawn", "shell_execute"],
          managerRisk: { level: "dangerous" },
        },
      });
      const collectorCode = collector?.execModel === "script" && collector.script.executable.kind === "inline" ? collector.script.executable.code : "";
      expect(collectorCode).toContain("process.getBuiltinModule('node:child_process')");
      expect(collectorCode).toContain("spawn('git', args, { shell: false");
      expect(collectorCode).not.toContain("import('node:");
      const report = review!.definition.nodes.find((node) => node.id === "report");
      expect(report).toMatchObject({
        execModel: "llm",
        outputFields: [{
          key: "answer_markdown",
          required: true,
          valueType: "string",
          artifact: { format: "markdown", fileName: "code-review-report.md" },
        }],
      });
      expect(report?.execModel === "llm" ? report.prompt : "").toContain("# 代码变更审查规范");
      expect(report?.execModel === "llm" ? report.prompt : "").not.toContain("__REVIEW_GUIDELINES__");
    }

    await expect(readFile(
      path.join(sourceRoot, "code-change-review", "workflow.json"),
      "utf8",
    )).resolves.toBe(await readFile(
      path.join(packagedRoot, "code-change-review", "workflow.json"),
      "utf8",
    ));
    await expect(readFile(
      path.join(sourceRoot, "code-change-review", "review-guidelines.md"),
      "utf8",
    )).resolves.toBe(await readFile(
      path.join(packagedRoot, "code-change-review", "review-guidelines.md"),
      "utf8",
    ));
  });
});
