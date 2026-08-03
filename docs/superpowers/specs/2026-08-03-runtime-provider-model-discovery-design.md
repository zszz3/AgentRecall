# Runtime 按 Provider 探测模型设计

## 目标

- Runtime 的模型探测以当前选中的 Provider 为数据来源，而不是以 Claude Code、Codex 等执行器决定是否支持。
- Claude Code + DeepSeek 等组合能够探测实际 Provider 提供的模型，并避免把执行接口地址误当成模型目录地址。
- 探测入口和结果清晰可见；失败时保留当前模型配置和手动输入能力。

## 模型目录解析

模型目录按以下优先级解析：

1. Provider 预置声明的模型目录地址。执行接口与目录接口不一致的 Provider 必须使用该地址，例如 Claude Code + DeepSeek 使用 `https://api.deepseek.com/models`，不在 `https://api.deepseek.com/anthropic` 后拼接 `/models`。
2. 自定义 OpenAI 兼容 Provider 根据当前 Base URL 推导 `/models`。推导时去除结尾斜杠；Base URL 已以 `/models` 结尾时直接使用。
3. Codex 官方配置继续使用本机 Codex CLI 的模型目录。
4. 没有目录能力的 Provider 返回明确的“不支持自动探测”错误，不使用其他 Runtime 或 Provider 的模型作为替代。

Provider 预置增加可选的模型目录元数据。探测逻辑根据 `presetId` 读取该元数据；Runtime 类型仅用于保留 Codex 官方 CLI 这一条特殊来源，不再一刀切地拒绝 Claude Code 配置。

## 数据流

用户点击“探测模型”后：

1. 前端先保存当前配置，确保最新的 Provider、Base URL、请求头和 API Key 已进入主进程。
2. 主进程按当前 channel 的 Provider 配置解析模型目录和认证请求头。
3. Provider 返回的模型 ID 去重后与当前模型列表合并；已有模型的用户标签和配置保持不变。
4. 合并结果通过现有配置存储落盘并刷新 Runtime 快照。

探测失败时不保存空列表，也不删除或替换当前模型。API Key 只作为请求头使用，不进入状态文案或错误详情。

## 界面与状态

- 将模型区域中仅有图标和悬浮提示的刷新操作改为带文字的“探测模型”按钮。
- 请求期间按钮进入忙碌态，避免重复请求。
- 成功后显示真实来源和数量，例如“已从 DeepSeek 探测到 2 个模型”。
- Provider 不支持、鉴权失败、超时或返回空目录时显示具体结果；当前模型列表继续可编辑。
- “添加模型”和手动编辑保留，模型目录不是使用 Provider 的前置条件。

## 错误边界

- 目录 URL 只从当前 Provider 预置或当前自定义 Base URL 产生，不跨 Provider 猜测。
- HTTP 非成功响应、超时、无有效模型均视为失败，并保持原配置。
- Provider 的执行协议与目录协议分开处理；Anthropic 兼容执行接口不代表目录也位于 Anthropic 路径下。
- 目录响应继续兼容常见的 `data` 和 `models` 数组，并忽略无有效 ID 的条目。

## 范围

- 只修改 V2。Runtime 配置不属于 V1/V2 共用的 Session 行为，V1 没有对应页面。
- 不改变 Agent 实际执行时的模型映射、Provider 余额查询或 Provider 页面已有的模型探测。
- 不要求所有 Provider 都支持在线目录；已知不支持的配置继续使用预置模型和手动输入。

## 验证

- 单元测试覆盖 Claude Code + DeepSeek 使用 DeepSeek 模型目录，而不是 `/anthropic/models`。
- 覆盖自定义 OpenAI 兼容 Base URL 推导、Codex 官方 CLI、Provider 不支持、HTTP 失败和空目录不覆盖原模型。
- 界面测试覆盖显式“探测模型”按钮、忙碌状态以及成功/失败状态文案。
- 运行 V2 类型检查、相关测试和 `npm run release-note:check`；保持当前 V2 进程运行。
