# HTTP MCP Server 支持鉴权请求头

## Bug 修复

- HTTP 类型的 MCP Server 现在可以配置自定义请求头（如 `Authorization`）：在 MCP 页面填写请求头名称并引用宿主机环境变量，密钥值不会保存到数据库。此前 HTTP Server 只能填 URL，需要鉴权的远程 MCP 服务无法接入。
- 配置的请求头会在连接测试和 Codex、Claude Code、Hermes、OpenCode、OpenClaw 会话中一并生效；从 JSON 导入含 `headers` 的 HTTP Server 时会保留请求头名称，等待补填环境变量引用。
