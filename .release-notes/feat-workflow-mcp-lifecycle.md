# Workflow MCP 生命周期控制

## 新增功能

- 可信的本地 Agent 现在可以通过 MCP 确认、启动、查询、停止 Workflow，并处理运行中的人工介入和结构化输入；外部客户端默认保持只读。
- Workflow 节点会话现在会在主时间线中显示工具调用和结果，并明确标记结构化节点结果的提交。
- Codex、Claude Code、OpenCode、Hermes 和 OpenClaw 现在遵循一致的 Workflow MCP 权限范围；规划会话中的工具失败会直接显示调用名称、状态和原因，不再被误报为工具不存在。
- Workflow 运行结果查询现在提供安全的文件类型、大小和受限文本预览，并自动隐藏授权信息与常见密钥内容。

## Bug 修复

- 修复 Workflow Agent 在工具尚未完成启动时创建会话，导致后续始终无法调用工作流工具的问题；Codex 失败时也会显示具体原因，不再只显示笼统错误。
- 修复使用第三方模型渠道的新版 Codex 在 Responses Lite 模式下丢失 Workflow MCP 工具、因而错误提示 `workflow_create` 未提供的问题。
