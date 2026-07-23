import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { workflowMcpLaunchConfig } from "./workflow-mcp-launch";

describe("workflowMcpLaunchConfig", () => {
  test("builds a development stdio server scoped to one workflow", () => {
    const serverScriptPath = path.join(process.cwd(), "src", "automation", "engine", "mcp", "server.ts");
    const config = workflowMcpLaunchConfig({
      discoveryPath: "C:/app/mcp-bridge.json",
      workflowId: "wf-1",
    }, {
      cwd: process.cwd(),
      mainBundlePath: path.join(process.cwd(), "missing", "index.js"),
      serverScriptPath,
    });
    expect(config).toMatchObject({
      command: process.execPath,
      env: {
        AGENT_RECALL_WORKFLOW_MCP_BRIDGE: "C:/app/mcp-bridge.json",
        AGENT_RECALL_WORKFLOW_ID: "wf-1",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    expect(config?.args.at(-1)).toBe(serverScriptPath);
  });

  test("prefers the bundled server beside the main bundle", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "workflow-mcp-launch-"));
    const mainBundlePath = path.join(dir, "index.js");
    const serverPath = path.join(dir, "mcp-server.js");
    await writeFile(serverPath, "", "utf8");
    const config = workflowMcpLaunchConfig({ discoveryPath: "C:/app/mcp-bridge.json", workflowId: "wf-2" }, { mainBundlePath });
    expect(config?.args).toEqual([serverPath]);
  });

  test("does not expose workflow tools outside a planning workflow", () => {
    expect(workflowMcpLaunchConfig({ discoveryPath: "C:/app/mcp-bridge.json" })).toBeUndefined();
  });

  test("passes managed credentials and node identity without writing them to discovery", () => {
    const config = workflowMcpLaunchConfig({
      discoveryPath: "C:/app/mcp-bridge.json",
      workflowId: "wf-1",
      runId: "run-1",
      nodeId: "node-1",
      managedToken: "managed-token",
    }, {
      cwd: process.cwd(),
      mainBundlePath: path.join(process.cwd(), "missing", "index.js"),
      serverScriptPath: path.join(process.cwd(), "src", "automation", "engine", "mcp", "server.ts"),
    });

    expect(config?.env).toMatchObject({
      AGENT_RECALL_WORKFLOW_RUN_ID: "run-1",
      AGENT_RECALL_WORKFLOW_NODE_ID: "node-1",
      AGENT_RECALL_WORKFLOW_MCP_TOKEN: "managed-token",
    });
  });
});
