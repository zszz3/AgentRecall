# 迁移目标运行时元数据设计

## 背景

迁移 writer 会生成目标 Agent 可直接读取的原生会话文件。Codex family 的会话元数据需要持久化 `model_provider`，Claude family 的 assistant 消息需要携带 `model`。这些字段如果缺失、写死或与目标 Agent 的实际配置不一致，可能导致 Resume 配置加载失败，或者让迁移后的历史消息显示错误的模型信息。

当前实现按 target 写死 Codex provider，并为所有 Claude assistant 消息写入 `session-migration`。这没有读取目标 CLI 的独立配置目录，因此无法正确支持自定义 provider、TClaude、TCodex、Claude Internal 和 Codex Internal 的独立配置。

## 目标

- 迁移时读取具体目标 Agent 自己的配置目录，而不是读取 agent-recall 保存的 API 配置。
- Codex family 将目标 `config.toml` 的有效 `model_provider` 写入 `session_meta.payload.model_provider`。
- Claude family 将目标 `settings.json` 中的有效模型写入历史 assistant 消息的 `message.model`。
- 配置缺失、不可读或损坏时使用目标安全默认值，不能让迁移流程额外失败。
- CodeBuddy 和 Cursor 不增加其原生格式不存在的 provider/model 字段。
- 写后结构校验必须验证最终落盘的运行时元数据。

## 方案

新增一个独立的目标运行时元数据解析模块。writer 根据 target 计算目标 home，例如 `.codex`、`.tcodex`、`.claude`，然后在序列化前异步读取该目录的配置。

解析结果使用 family 专属字段，避免把 Codex provider 和 Claude model 混成一个含义不清的通用字符串：

```ts
export interface MigrationTargetRuntimeMetadata {
  codexModelProvider?: string;
  claudeModel?: string;
}
```

Codex 解析规则：

1. 读取 `config.toml` 根级别、首个 TOML section 之前的 `model_provider`。
2. 如果根级别 `profile` 选择了 `[profiles.<name>]`，则使用该 profile 的 `model_provider` 覆盖根级别值。
3. 忽略未被选择的 profile、空值和无法解析的值。
4. 没有有效 provider 时，`codex` 和 `codex-internal` 回退到 `openai`，`tcodex` 回退到 `tencent`。

Claude 解析规则：

1. 读取 `settings.json`。
2. 优先使用 `env.ANTHROPIC_MODEL`，其次使用顶层 `model`。
3. 缺失、非字符串、空字符串或 JSON 损坏时回退到 `session-migration`。

CodeBuddy 和 Cursor 返回空元数据，writer 保持现有原生格式。

## 数据流

`writeMigratedSession` 先确定 target home，再加载运行时元数据，然后将同一份解析结果同时传给 serializer 和原生结构 validator。serializer 负责落盘；validator 验证 Codex meta 或每个 Claude assistant row 中的值与解析结果一致。Loader round-trip 继续验证会话内容、ID、标题和消息链，不承担 provider/model 配置校验。

## 错误处理

目标配置属于外部 CLI 状态。文件不存在、权限不足或内容损坏时，解析器统一回退，不抛出新的迁移错误。这样生成的文件仍具有非空、可识别的原生字段。若配置明确给出了非空自定义 provider/model，则按原值保留；目标 CLI 是否支持该显式配置由目标 CLI 自身负责。

## 测试

- 三个 Codex target 分别验证自定义顶层 provider 被写入。
- 验证 Codex target 的缺失配置默认值，以及 Codex Internal 默认回退为 `openai`。
- 验证被选中的 profile 覆盖根 provider、未选中的 profile 不会被误认为活动 provider，并验证损坏配置回退。
- 三个 Claude target 分别验证 `ANTHROPIC_MODEL` 被写入 assistant rows。
- 验证 Claude 顶层 `model` 回退、环境模型优先级、缺失配置和损坏 JSON 回退。
- 复用现有 writer 权限、原子写入、结构校验、round-trip 和清理测试。
