# OpenViking 支持自定义 OpenAI Responses Provider

## Bug 修复

- 使用自定义 OpenAI Responses 接口作为摘要 Provider 时，现在可以正常创建并运行目录 Memory。
- 保存专用的 AI 摘要与搜索配置后，即使 Codex 同时使用自定义 Provider，也会正确显示已经保存的接口地址、模型和 API Key。
- 自定义 AI 摘要与搜索 Provider 现在可以明确选择 OpenAI Chat Completions 或 OpenAI Responses API，避免接口协议判断错误。
- 升级后会自动补齐目录 Memory 所需的数据结构，避免搜索、诊断或批量删除时提示数据不存在。
