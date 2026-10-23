"use strict";

const { requestSessionBackend } = require("./session-backend-client.cjs");

const HELP = `独立本机会话搜索（不会打开桌面窗口）：
  agent-recall-v2 session search <查询> [--source <来源>] [--project <目录>] [--limit <数量>] [--json]
  agent-recall-v2 session get <sessionKey> [--offset <偏移>] [--limit <消息数>] [--json]
  agent-recall-v2 backend status [--json]
  agent-recall-v2 backend stop [--json]
搜索时自动启动后台并更新索引；闲置五分钟后退出。团队、资源和记忆检索仍使用桌面。`;

async function runSessionBackendCommand(argv, options = {}) {
  const write = options.write || ((text) => process.stdout.write(text));
  const errorWrite = options.errorWrite || ((text) => process.stderr.write(text));
  const json = argv.includes("--json");
  try {
    if (argv.includes("--help") || argv.includes("-h")) { write(`${HELP}\n`); return 0; }
    const [kind, action, ...rest] = argv;
    let body = {};
    const clientOptions = { ...options.clientOptions };
    if (kind === "backend") {
      if (!["status", "stop"].includes(action) || rest.some((value) => value !== "--json")) throw new Error(HELP);
      clientOptions.start = false;
    } else if (kind === "session" && ["search", "get"].includes(action)) {
      const value = rest.shift();
      if (value === undefined || value === "--json") throw new Error("缺少查询或 sessionKey。\n" + HELP);
      body = action === "search" ? { query: value } : { sessionKey: value };
      const allowed = action === "search" ? ["source", "project", "limit"] : ["offset", "limit"];
      const seen = new Set();
      while (rest.length) {
        const flag = rest.shift();
        if (flag === "--json") continue;
        const key = flag?.startsWith("--") ? flag.slice(2) : "";
        const value = rest.shift();
        if (!allowed.includes(key) || value === undefined || seen.has(key)) throw new Error("参数无效或重复。\n" + HELP);
        seen.add(key);
        if (key === "limit" || key === "offset") {
          const number = Number(value);
          const max = key === "offset" ? 200000 : action === "get" ? 200 : 50;
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < (key === "offset" ? 0 : 1) || number > max) throw new Error(`--${key} 超出允许范围。`);
          body[key === "limit" && action === "get" ? "maxMessages" : key] = number;
        } else body[key] = value;
      }
    } else throw new Error(HELP);
    const data = await requestSessionBackend(action, body, clientOptions);
    write(`${JSON.stringify(json ? { ok: true, data } : data, null, json ? undefined : 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) write(`${JSON.stringify({ ok: false, error: { code: "SESSION_BACKEND_FAILED", message } })}\n`);
    else errorWrite(`${message}\n`);
    return 1;
  }
}

module.exports = { runSessionBackendCommand };
