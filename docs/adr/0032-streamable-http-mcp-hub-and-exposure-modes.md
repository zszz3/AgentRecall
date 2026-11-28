# ADR 0032：标准 Streamable HTTP MCP Hub、双暴露模式与多客户端接入

## 状态

已采用。

## 背景

AgentRecall 2.0 早期 MCP Gateway 仅通过 STDIO 入口（`out/mcp/gateway-entry.js` 经私有 HTTP Bridge 转发）面向外部客户端，且存在四方面限制：

1. 仅支持一键配置 Codex 与 Claude Code，无法直接接入 Cursor、Gemini CLI、OpenCode、Qwen Code、ZCode 等原生支持 Streamable HTTP 的编码客户端；
2. 外部客户端只能共享同一份全局工具目录，无法按客户端裁剪暴露的工具源子集；
3. 所有第三方工具均强制隐藏在 `search_tools` / `get_tool` / `call_tool` 元工具背后，既增加调用轮次，又让客户端权限审批只能看到笼统的 `call_tool`；
4. 缺少 `notifications/tools/list_changed`，在桌面端启停工具源或单工具后客户端无法即时感知。

## 决策

1. **在主进程提供独立的 loopback Streamable HTTP MCP Hub（默认 `127.0.0.1:4326`）**：
   - 与默认关闭的本地模型网关（`127.0.0.1:4325`）解耦，避免未开启模型网关时无法使用 MCP Hub；
   - 暴露 `/mcp`（全局目录）与 `/mcp/<clientId>`（按客户端过滤子集），采用持久化本地 32-byte 随机 Bearer Token 鉴权；
   - 声明 `capabilities.tools.listChanged = true`，工具源、单工具开关或客户端允许列表变化时主动广播 `notifications/tools/list_changed`；
   - 若端口冲突（`EADDRINUSE`），在 Hub 状态中暴露可读错误而不阻断桌面端启动。
2. **保留原有 STDIO Gateway 入口兼容**：
   - Codex 与 Claude Code 默认维持 STDIO 兼容（保证离线本机会话检索能力不回退），并可在「连接客户端」弹窗中一键切换至 HTTP Hub；
   - Cursor、Gemini CLI、OpenCode、Qwen Code、ZCode 默认 opt-in（不主动改写用户已有配置），启用时写入各自原生的 Streamable HTTP 配置字段（如 Gemini/Qwen 的 `httpUrl`、OpenCode 的 `mcp.<name>.type = "remote"`）。
3. **第三方工具源支持按源选择 `exposureMode`（`indexed` | `direct`）**：
   - PostgreSQL 迁移 #65 为 `agent_recall.mcp_servers` 增加 `exposure_mode` 列，默认 `indexed` 保证升级无破坏；
   - `direct` 模式将该源启用工具以 `<sourceSlug>__<toolName>` 直接暴露在 `tools/list`，并从 `search_tools` 索引中排除以避免重复；调用时仍实时校验来源/单工具开关与客户端允许列表。

## 影响

- 下游连接池、HTTP Hub 会话和工具权限校验全部由主进程 `NativeAutomationService` 与 `McpAutomationModule` 统一拥有，在应用退出时确定性关闭所有活跃 HTTP 会话与下游子进程；
- 新增客户端只需在 `setup-mcp.cjs`、`MCP_HUB_CLIENT_IDS` 与 `mcpExternalClientUpdateSchema` 中声明路径与格式即可复用同一路由与权限模型。

## 考虑的替代方案

- **把 `/mcp` 挂在本地模型网关（`4325`）下**：模型网关默认关闭且负责 LLM 协议代理，强绑定会让不使用模型网关的用户无法启用 MCP Hub，放弃；
- **全局强制改为直出模式**：对于挂载数十个大型 MCP 的用户会迅速撑爆上下文，保留按源切换兼顾两类场景。

## 关联

- [MCP 功能规格](../spec/mcp.md)
- [Streamable HTTP Hub 实现](../../apps/main-2.0/src/main/services/mcp-http-hub.ts)
- [MCP 自动化模块](../../apps/main-2.0/src/main/services/mcp-automation-module.ts)
- [客户端配置脚本](../../apps/main-2.0/bin/setup-mcp.cjs)
