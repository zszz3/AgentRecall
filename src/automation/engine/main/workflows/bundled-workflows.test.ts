import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
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
});
