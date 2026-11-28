#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DATABASE_POINTER = "database-url";
let evalBundle = null;

function resolveAppVersion(packageUrl = new URL("../package.json", import.meta.url)) {
  try {
    const value = JSON.parse(readFileSync(fileURLToPath(packageUrl), "utf8"));
    return typeof value.version === "string" && value.version ? value.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function resolveDatabaseUrl(env = process.env, home = homedir()) {
  const override = env.AGENT_RECALL_DATABASE_URL && env.AGENT_RECALL_DATABASE_URL.trim();
  if (override) return override;
  const pointer = path.join(home, ".agent-recall-v2", DATABASE_POINTER);
  try {
    if (!existsSync(pointer)) return null;
    return readFileSync(pointer, "utf8").trim() || null;
  } catch {
    return null;
  }
}

const REQUIRED_EXPORTS = [
  "openEvalStore",
  "listEvalDatasets",
  "getEvalDataset",
  "writeEvalDataset",
  "addEvalDatasetCases",
  "importEvalDatasetFolder",
  "exportEvalDatasetFolder",
  "listEvalEvaluators",
  "listEvalGraphs",
  "listEvalRuns",
  "getEvalRunReport",
];

function validateEvalBundle(bundle) {
  for (const name of REQUIRED_EXPORTS) {
    if (typeof bundle?.[name] !== "function") {
      throw new Error(`Eval bundle is missing ${name}`);
    }
  }
}

async function loadEvalBundle() {
  if (evalBundle) return evalBundle;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "out", "mcp", "eval-entry.js"),
    path.join(here, "eval-entry.js"),
  ];
  let lastError = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const candidateBundle = await import(pathToFileURL(candidate).href);
      validateEvalBundle(candidateBundle);
      evalBundle = candidateBundle;
      return evalBundle;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "MCP Eval bundle not found. Run `npm run build:mcp` first." +
    (lastError ? ` (${lastError instanceof Error ? lastError.message : String(lastError)})` : ""),
  );
}

function jsonContent(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function tool(operation) {
  try {
    return jsonContent(await operation());
  } catch (error) {
    return errorContent(error instanceof Error ? error.message : String(error));
  }
}

export function registerEvalTools(server, zod, store, bundle) {
  const caseSchema = zod.object({
    input: zod.string().min(1).describe("交给 Agent 的任务输入。"),
    expectedOutput: zod.string().optional().describe("期望输出；缺省时确定性评分器无法判定该用例。"),
    context: zod.string().optional().describe("提供给评判器的额外上下文。"),
  });

  server.registerTool(
    "list_eval_datasets",
    {
      description: "列出 AgentRecall 的评测数据集，只返回名称、描述和用例数；读取用例请调用 get_eval_dataset。",
      inputSchema: {},
    },
    async () => tool(() => bundle.listEvalDatasets(store)),
  );

  server.registerTool(
    "get_eval_dataset",
    {
      description: "读取一个评测数据集的全部用例，可用数据集 id 或名称查找。",
      inputSchema: {
        dataset: zod.string().min(1).describe("数据集 id 或名称。"),
      },
    },
    async ({ dataset }) => tool(async () => {
      const found = await bundle.getEvalDataset(store, dataset);
      if (!found) throw new Error(`未找到数据集：${dataset}`);
      return found;
    }),
  );

  server.registerTool(
    "write_eval_dataset",
    {
      description:
        "创建评测数据集，或整体替换已有数据集的用例。替换是完全替换：原有用例会被全部丢弃，"
        + "因为数据集是评分所依据的规格，静默合并会改变分数的含义。只想追加请用 add_eval_dataset_cases。",
      inputSchema: {
        name: zod.string().min(1).describe("数据集名称；同名视为同一个数据集。"),
        cases: zod.array(caseSchema).min(1).describe("完整的用例列表，将替换原有全部用例。"),
        description: zod.string().optional().describe("数据集说明。"),
        datasetId: zod.string().optional().describe("要替换的数据集 id；缺省时按名称查找或新建。"),
      },
    },
    async (args) => tool(() => bundle.writeEvalDataset(store, args)),
  );

  server.registerTool(
    "add_eval_dataset_cases",
    {
      description: "向已有评测数据集追加用例，原有用例保持不变。",
      inputSchema: {
        datasetId: zod.string().min(1).describe("数据集 id 或名称。"),
        cases: zod.array(caseSchema).min(1).describe("要追加的用例。"),
      },
    },
    async (args) => tool(() => bundle.addEvalDatasetCases(store, args)),
  );

  server.registerTool(
    "import_eval_dataset_folder",
    {
      description:
        "把磁盘上的数据集文件夹导入 AgentRecall。文件夹用 dataset.md 写总览（可带 name/description/tags 的 YAML 头），"
        + "cases/ 下每个 .json 一条用例（input、可选 expectedOutput、context、metadata）。"
        + "这些文件你可以直接用文件工具写；导入的数据集 id 由文件夹路径决定，"
        + "所以改完文件再导入同一个文件夹是更新而不是新建。读不了的用例文件会在 errors 里逐条列出。",
      inputSchema: {
        directory: zod.string().min(1).describe("数据集文件夹的绝对路径。"),
      },
    },
    async ({ directory }) => tool(() => bundle.importEvalDatasetFolder(store, directory)),
  );

  server.registerTool(
    "export_eval_dataset_folder",
    {
      description:
        "把 AgentRecall 里的数据集写成文件夹格式（dataset.md + cases/*.json），便于直接阅读和逐条修改。"
        + "目标文件夹里 cases/ 下已有的 .json 会先清空，其他文件保留。",
      inputSchema: {
        dataset: zod.string().min(1).describe("数据集 id 或名称。"),
        directory: zod.string().min(1).describe("写入目标文件夹的绝对路径。"),
      },
    },
    async ({ dataset, directory }) =>
      tool(() => bundle.exportEvalDatasetFolder(store, dataset, directory)),
  );

  server.registerTool(
    "list_eval_evaluators",
    {
      description: "列出可用的评分器及其判定阈值，用于组装评测图。",
      inputSchema: {},
    },
    async () => tool(() => bundle.listEvalEvaluators(store)),
  );

  server.registerTool(
    "list_eval_graphs",
    {
      description: "列出评测实验及其数据集、Agent，并标明它跑的是自定义执行图还是默认形状。",
      inputSchema: {},
    },
    async () => tool(() => bundle.listEvalGraphs(store)),
  );

  server.registerTool(
    "list_eval_runs",
    {
      description: "列出评测运行记录及其通过率；未评分用例数说明有多少用例没能得出结论。",
      inputSchema: {
        experimentId: zod.string().optional().describe("只看某个实验的运行。"),
        limit: zod.number().optional().describe("返回条数，最多 50，默认 10。"),
      },
    },
    async (args) => tool(() => bundle.listEvalRuns(store, args ?? {})),
  );

  server.registerTool(
    "get_eval_run",
    {
      description:
        "读取一次评测运行的逐用例执行步骤。每步带状态与「没产出的原因」，"
        + "可据此区分「评判器判为不通过」和「评判器根本没能运行」。",
      inputSchema: {
        runId: zod.string().min(1).describe("list_eval_runs 返回的 runId。"),
      },
    },
    async ({ runId }) => tool(async () => {
      const report = await bundle.getEvalRunReport(store, runId);
      if (!report) throw new Error(`未找到运行记录：${runId}`);
      return report;
    }),
  );
}

async function runServer() {
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    process.stderr.write(
      "未找到 AgentRecall 的数据库地址。请先打开 App，或设置 AGENT_RECALL_DATABASE_URL。\n",
    );
    process.exit(1);
  }

  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const bundle = await loadEvalBundle();
  let store;
  let close;
  if (databaseUrl.toLowerCase().startsWith("sqlite:")) {
    if (typeof bundle.openSqliteEvalStore !== "function") {
      throw new Error("Eval bundle is missing openSqliteEvalStore. Run `npm run build:mcp` first.");
    }
    ({ store, close } = bundle.openSqliteEvalStore(databaseUrl));
  } else {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: "agent-recall-eval-mcp",
    });
    await pool.query("SELECT 1");
    ({ store, close } = bundle.openEvalStore(pool));
  }
  const server = new McpServer({ name: "agent-recall-eval", version: resolveAppVersion() });
  registerEvalTools(server, z, store, bundle);
  // The database connection outlives every tool call; closing it is the transport's business.
  process.once("exit", () => {
    void close();
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runServer().catch((error) => {
    process.stderr.write(
      `AgentRecall Eval MCP 启动失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
