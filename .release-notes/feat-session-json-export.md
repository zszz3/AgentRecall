# 会话请求体 JSON 导出

## 新增功能

- 会话详情现在可导出为 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 格式的 JSON 请求体；Codex 会话会尽可能保留模型、指令、并行工具调用、结构化工具结果、推理与流式参数，并在本地启用请求 trace 时支持导出原始 OpenAI Responses 请求体。导出完成后会明确提示本次使用的是原始 trace、历史重建还是标准化格式。
