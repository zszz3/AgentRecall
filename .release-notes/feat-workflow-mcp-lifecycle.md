# Workflow MCP 生命周期控制

## 新增功能

- 可信的本地 Agent 现在可以通过 MCP 确认、启动、查询、停止 Workflow，并处理运行中的人工介入和结构化输入；外部客户端默认保持只读。
- Workflow 节点会话现在会在主时间线中显示工具调用和结果，并明确标记结构化节点结果的提交。
- Codex、Claude Code、OpenCode、Hermes 和 OpenClaw 现在遵循一致的 Workflow MCP 权限范围；规划会话中的工具失败会直接显示调用名称、状态和原因，不再被误报为工具不存在。
- Workflow 运行结果查询现在提供安全的文件类型、大小和受限文本预览，并自动隐藏授权信息与常见密钥内容。

## Bug 修复

- 修复 Workflow Agent 在工具尚未完成启动时创建会话，导致后续始终无法调用工作流工具的问题；Codex 失败时也会显示具体原因，不再只显示笼统错误。
- 修复使用第三方模型渠道的新版 Codex 在 Responses Lite 模式下丢失 Workflow MCP 工具、因而错误提示 `workflow_create` 未提供的问题。
- 修复新版 Codex 将安全的 Workflow 草稿写入误判为需人工批准并立即拒绝，导致已暴露的 `workflow_create` 仍无法执行的问题。
- Workflow Agent 遇到确实需要用户确认的工具调用时，现在会在草稿会话中显示可操作的审批卡片，不再因缺少审批界面而直接拒绝。
- Workflow 节点的结构化结果现在会在工具调用时直接可靠保存，运行与恢复不再依赖会话历史中的展示文本，较长 Markdown 也不会因摘要截断而被误判为非法输出。
- 修复要求生成文档的 Workflow 只保存结构化文本、却没有在运行产物目录生成文件的问题；Markdown 等声明为文档产物的输出现在会稳定落盘，已有 `answer_markdown` 工作流无需重建。
