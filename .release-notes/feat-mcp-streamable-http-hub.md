# MCP 支持标准 Streamable HTTP Hub、直出模式与 7 客户端一键接入

## 新增功能

- ✨ 新增内置 Streamable HTTP MCP Hub（默认 `127.0.0.1:4326/mcp`），支持按客户端隔离路径（`/mcp/<agent>`）、独立筛选每个客户端可见的工具源，以及工具变更时自动推送实时刷新通知。
- ✨ 第三方 MCP 工具源新增「暴露模式」切换：支持「按需索引（`search_tools`）」或「直接暴露（`<source>__<tool>`）」，兼顾节省上下文与客户端单工具权限审批。
- ✨ 「连接客户端」扩展支持 7 个编码客户端：除 Codex、Claude Code（支持 HTTP Hub / STDIO 切换）外，新增 Cursor、Gemini CLI、OpenCode、Qwen Code 与 ZCode 一键接入。
