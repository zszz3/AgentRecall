# 个人 Library：MCP 服务器同步到所有本机 Agent

<!-- release-target: v2 -->

## 新增功能

- 🔌 「Library」页新增 MCP 服务器：写一份服务器列表，按需开启 Claude Code、Codex、Gemini CLI、OpenCode、Qwen Code、Cursor、ZCode，会按各自的格式写进它们的用户级 MCP 配置；开启前会列出将新增、替换和移除的服务器。
- 📥 MCP 服务器也可以「从 Agent 导入」，各 Agent 中相同的服务器只列一次。
- 🛡️ Agent 里已有同名服务器，或 AgentRecall 写入的服务器被手动改过时保持原样并提示，可选择覆盖（先备份）；关闭某个 Agent 或卸载 AgentRecall 时只移除 AgentRecall 写入且未被改过的服务器。
