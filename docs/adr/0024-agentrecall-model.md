# ADR 0024：AgentRecall 自己的 AI 任务直接调用用户设置的模型 API

## 状态

已采用，适用于 V2。替代 [ADR 0023](0023-v2-experience-cards.md) 中「提炼由用户选择 Runtime 渠道」的决定。

## 背景

经验卡提炼和 AI Skill 探索原来通过 Runtime 的一次性执行调用模型：用户选择一个执行渠道，AgentRecall 启动对应的 Codex、Claude Code 等 Agent 或 API 渠道完成一次问答。这两个任务都只需要发一段提示、取回一个 JSON 回答，走 Runtime 却带来这些问题：

- 启动编码 Agent 要加载它的系统提示、工具和登录状态，一次问答慢且费额度；
- Agent 渠道每次调用都会产生一个原生会话，进入索引后还要靠调用记录再区分出来；
- 一次性执行不报告 Token 用量，Memory 页只能显示「未知」；
- 渠道在 Runtime 页配置，和使用它的 Memory、Skills 分开，用户要先理解 Runtime 才能用这两个功能。

## 决策

- AgentRecall 自己的 AI 任务（经验卡提炼、AI Skill 探索）由桌面主进程直接调用一个用户设置的模型 API，称为「AgentRecall 模型」。不经过 Runtime，不启动编码 Agent。
- 调用通过 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)（MIT）完成，它提供多家服务商的模型目录，以及统一的请求、流式解析和错误结果。只提供凭一个 API Key 即可调用的服务商；目录之外的接口按 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 格式自定义。
- 设置文件只保存服务商、模型、自定义地址和接口格式。API Key 按服务商保存在主进程已有的服务商密钥表中，renderer 只能查询是否已保存。
- 用户可以从本机其他 Agent（ZCode、DeepSeek Harness、Codex、Claude Code、CC Switch、Pi、StepCode、OpenCode）导入它们已经在用的服务。主进程只读这些 Agent 的配置，不运行 Key 命令，不解密加密存储；Key 不传给 renderer，保存时复制到 AgentRecall 的密钥表，之后不跟随来源变化。
- 没有设置模型或缺少 Key 时，调用方停止并提示到 Provider 页设置，不回退到 Runtime 或其他模型。
- 旧设置中的两个 Runtime 渠道选择在加载时丢弃，不迁移。

## 影响

- 这两个任务不再产生 Agent 会话和 Runtime 调用记录；Memory 页可以显示模型返回的 Token 用量。
- 调用消耗所选模型的 API 用量，不能使用 Claude Code、Codex 的订阅额度。ADR 0023 中「订阅额度低于 25% 时暂停提炼」因此不再适用。
- 升级前选过渠道的用户需要重新设置模型：经验卡提炼停在「尚未设置」，AI Skill 探索提示去设置。
- 主进程新增 pi-ai 依赖，连同它带来的 OpenAI、Anthropic、Google 和 AWS SDK。
- API Key 与服务商配置的 Key 同表保存，保护级别相同：数据库中未加密。
- 导入的 Key 是副本：来源 Agent 更换 Key 后，需要重新导入或填写。AgentRecall 要跟上这些 Agent 的配置格式；格式无法读取时，导入列表说明原因，不影响手动设置。
- 会话摘要、AI 找会话和迁移压缩仍使用「AI 摘要与搜索」设置；Eval 的评审与候选执行仍使用 Runtime Agent。它们是否改用 AgentRecall 模型另行决定。

## 考虑的替代方案

- 继续使用 Runtime 渠道：启动成本、额外会话和用量不可见的问题都还在，未采用。
- 通过 ACP 调用本机 Agent（codex-acp、claude-agent-acp、`dsh --profile acp`）：ACP 没有一次性问答和 JSON 输出模式，Agent 仍会写入自己的会话历史，未采用。
- 自己实现几家服务商的协议：要分别处理请求格式、流式解析、用量和错误，维护成本高于引入一个成熟的库，未采用。
- 引入 Agent 循环（pi-agent-core）：目前两个任务都是单次问答，用不到工具调用和多轮循环，暂不引入。
- 导入时只记住来源，每次调用再去其他 Agent 读取 Key：来源 Agent 改名、移动或删除服务后，后台提炼会在用户不知情时失败，而且每次调用都要解析别的应用的配置，未采用。

## 关联

[服务商配置规格](../spec/providers.md#agentrecall-模型)、[Memory 规格](../spec/memory.md)、[Skills 规格](../spec/skills.md)、[模型调用](../../apps/main-2.0/src/core/agent-model.ts)、[从其他 Agent 导入](../../apps/main-2.0/src/core/agent-model-imports.ts)、[模型服务](../../apps/main-2.0/src/main/services/agent-model-service.ts)、[设置结构](../../apps/main-2.0/src/core/agent-model-config.ts)。
