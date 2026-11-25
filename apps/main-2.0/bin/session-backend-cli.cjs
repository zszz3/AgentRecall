"use strict";

const { requestSessionBackend } = require("./session-backend-client.cjs");

const HELP = `独立本机会话搜索（不会打开桌面窗口）：
  agent-recall session search <查询> [--source <来源>] [--project <目录>] [--limit <数量>] [--json]
  agent-recall session get <sessionKey> [--turn-index <轮次>] [--offset <偏移>] [--limit <消息数>] [--json]
  agent-recall backend start [--json]
  agent-recall backend status [--json]
  agent-recall backend stop [--json]
搜索时自动启动后台并更新索引；退出桌面后常驻并每十分钟刷新索引，可用 backend stop 手动停止。团队、资源和记忆检索仍使用桌面。`;

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
      if (!["start", "status", "stop"].includes(action) || rest.some((value) => value !== "--json")) throw new Error(HELP);
      clientOptions.start = action === "start";
    } else if (kind === "session" && ["search", "get"].includes(action)) {
      const value = rest.shift();
      if (value === undefined || value === "--json") throw new Error("缺少查询或 sessionKey。\n" + HELP);
      body = action === "search" ? { query: value } : { sessionKey: value };
      const allowed = action === "search" ? ["source", "project", "limit"] : ["offset", "limit", "turn-index"];
      const seen = new Set();
      while (rest.length) {
        const flag = rest.shift();
        if (flag === "--json") continue;
        const key = flag?.startsWith("--") ? flag.slice(2) : "";
        const value = rest.shift();
        if (!allowed.includes(key) || value === undefined || seen.has(key)) throw new Error("参数无效或重复。\n" + HELP);
        seen.add(key);
        if (key === "limit" || key === "offset" || key === "turn-index") {
          const number = Number(value);
          const max = key === "limit" ? (action === "get" ? 200 : 50) : 200000;
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < (key === "limit" ? 1 : 0) || number > max) throw new Error(`--${key} 超出允许范围。`);
          body[key === "limit" && action === "get" ? "maxMessages" : key === "turn-index" ? "turnIndex" : key] = number;
        } else body[key] = value;
      }
    } else throw new Error(HELP);
    const data = await requestSessionBackend(kind === "backend" && action === "start" ? "status" : action, body, clientOptions);
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
