# V2 服务商配置

范围：V2 Provider 页面。V1 的单套配置界面保持原状；本模块不改变会话索引与 Resume。

## 使用流程

服务商页按 Codex、Claude Code 分组，列表中显示官方账号入口和已保存的配置。添加、编辑在独立面板完成；服务模板只填充字段，不代表启用。配置目录和协议放在可展开区域，连接测试仍是用户主动操作。Codex、Claude Code 和摘要表单使用统一的控件高度、圆角、背景与键盘焦点样式，密钥显示按钮嵌入输入框；表单在窄窗口下改为单列。

保存仅保存到 AgentRecall。启用才写入对应客户端配置，写入完成后显示“已写入”，并提示在客户端新建会话。此状态不是对已有运行中会话的路由保证。页面单独读取客户端当前配置；不能用已保存记录推断当前生效状态。

删除须二次确认，只删除应用中的配置，保留客户端当前配置。没有密钥的自定义配置可以保存草稿，但启用和连接测试前须填写密钥，避免误用另一套同名配置的密钥。

AI 摘要与搜索使用独立入口，保留原有来源选择。可复制已保存的 Codex 兼容 API 配置到摘要草稿，保存摘要设置后生效；这是一份独立副本，不会自动跟随服务商编辑。Claude CLI 摘要仍按原有客户端配置目录运行。

## AgentRecall 模型

页面标题栏的 **AgentRecall 模型** 打开独立页面，设置 AgentRecall 自己调用的模型。[经验卡提炼](memory.md)和 [AI Skill 探索](skills.md)使用它；会话摘要、AI 找会话和迁移压缩仍使用「AI 摘要与搜索」，Eval 仍使用 [Runtime](runtime.md) 中的 Agent。Memory 页和设置中的 Skills 分区可以直接跳到这里。决策见 [ADR 0024](../adr/0024-agentrecall-model.md)。

- 服务商列表来自 [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) 的内置目录，只列出凭一个 API Key 即可调用、且有对话模型的服务商；需要云账号凭据、资源地址或登录流程的服务商（如 Amazon Bedrock、Azure、Google Vertex、GitHub Copilot）不提供。目录之外的接口选「自定义接口」，填写地址、模型 ID 和接口格式（OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages）。
- API Key 按服务商保存在主进程的服务商密钥表中，设置文件只保存服务商、模型、自定义地址和接口格式。renderer 只能查询某个服务商是否已有 Key，不能读回 Key。所有自定义接口共用一个 Key：修改接口地址后留空 Key，已保存的 Key 会发给新地址。
- **测试** 和 **保存** 前，目录中的服务商必须填写 Key、选择了导入项或已保存 Key，自定义接口可以不填。
- **测试** 使用填写的 Key；未填写时使用所选导入项的 Key，再其次使用已保存的 Key。测试发送一句固定提示，30 秒内没有回答即失败，不保存任何内容。
- **保存** 先保存 Key，再保存设置；设置写入的结果显示在页面底部的设置状态中。

### 从其他 Agent 导入

页面打开时，主进程读取本机其他 Agent 已经在用的模型服务，供 **从 Agent 导入** 选择：

| Agent | 读取内容 |
| --- | --- |
| ZCode | `~/.zcode/v2/provider_config.json` 中启用的服务商；使用内置模板的服务商从 ZCode 缓存的模板补全地址和接口格式。被关闭的模型不导入。 |
| DeepSeek Harness | `$DSH_HOME`（默认 `~/.dsh`）下各配置档的 `cordis.patch.yml` 中的 DeepSeek 和 pi-ai 服务商；Key 先取 `.credentials.yaml`，再取环境变量。 |
| Codex | `config.toml` 当前使用的服务商和模型；Key 取自配置、环境变量、`auth.json` 或 `.env`，不借用其他服务商的 Key。 |
| Claude Code | `settings.json` 和环境变量中的地址、Key 和模型。 |
| CC Switch | `~/.cc-switch/cc-switch.db` 中各应用的服务商：Claude 和 Claude Desktop 的 `env`，Codex 的 `auth` 与 `config`，Gemini 不带自定义地址的 `GEMINI_API_KEY`，以及 OpenCode、OpenClaw、Pi、Hermes 等带地址和 Key 的条目。以 `{env:…}`、`${…}` 或 `!` 开头的 Key 是引用，不导入。 |
| Pi | `$PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）下的 `models.json` 和 `auth.json`；Key 可以是原文或环境变量名，`!` 开头的命令不运行。没有地址、编号又是目录中服务商的条目归到该服务商。 |
| StepCode | `~/.stepcode` 下格式与 Pi 相同的 `models.json` 和 `auth.json`。 |
| OpenCode | `$XDG_DATA_HOME/opencode/auth.json`（默认 `~/.local/share/opencode`，Windows 相同）中 `opencode auth login` 保存的 Key。文件只记 Key 不记地址，所以只导入地址与目录中服务商一致的编号，例如 `deepseek`、`openai`、`anthropic`。 |

- 只读这些文件，不写入、不运行 Key 命令、不解密加密存储。登录账号、Key 命令或其他接口格式的服务不导入；需要额外请求头或查询参数的服务也不导入，并在页面上说明原因，因为调用不会发送它们。指向 magpie 本机网关（`127.0.0.1:3425`）的条目不导入，因为它的 Key 只对网关有效。PI-Desktop 的 Key 加密保存，暂不导入。
- 地址主机和 Key 都相同的服务合并为一项，列出来源 Agent；同一服务里相同的接口和模型只出现一次。目录中的服务商能提供的模型改用该服务商；同一模型有多个自定义接口时，选项标出接口格式，必要时标出路径。
- 选择导入项会填入服务商、模型和接口。Key 留在主进程，renderer 只拿到服务的编号、名称、主机、来源和可选模型；编号每次启动重新生成，不能用来推断 Key。
- **保存** 把导入的 Key 复制到 AgentRecall 的密钥表，之后其他 Agent 修改或删除 Key 不影响 AgentRecall。导入的 Key 只发给该服务的接口：改了地址或接口格式，或手动选择服务商后，需要重新选择导入项或填写 Key。
- 某个 Agent 的配置无法读取或解析时，页面显示原因，其他 Agent 的结果照常列出。
- ZCode 的 Anthropic 地址去掉末尾 `/v1`，因为调用时会追加 `/v1/messages`。Claude Code 的 `ANTHROPIC_AUTH_TOKEN` 也作为 Key 导入，但调用以 `x-api-key` 请求头发送 Key；只接受 `Authorization` 请求头的网关会在测试时失败。

调用规则：

- 每次调用只发送一条用户消息，5 分钟内没有回答即失败。调用不启动编码 Agent，不产生 Agent 会话，也不写入 Runtime 调用记录。
- 模型报错、回答被输出上限截断或为空时调用失败，错误带上服务商返回的原因。
- 返回的 Token 用量中，输入包含命中缓存的部分；服务商没有返回用量时记为未知，不按零计算。
- 每次调用最多请求 32,768 个输出 Token，且不超过目录中该模型的上限；自定义接口按 8,192 个计算。自定义的 OpenAI Chat Completions 接口用 `max_tokens` 限制输出且不发送 `store`，以兼容常见网关。
- 未设置模型、服务商不受支持或缺少 Key 时，调用方停止并提示到这里设置，不改用其他模型或 Runtime。

旧版本设置中的「AI Skill 探索使用的 Runtime」和「经验卡提炼使用的 Runtime」在加载时忽略，下次保存时不再写出。Runtime 渠道不能对应到 API Key，所以不迁移，需要重新设置。

## 数据、接口与兼容

主进程 [ProviderService](../../apps/main-2.0/src/main/services/provider-service.ts) 拥有配置库；renderer 只通过[类型化 IPC](../../apps/main-2.0/src/shared/ipc/providers.ts)列举、读取、保存、删除。列表不携带密钥；编辑或启用单条记录时读取该条凭据。

AgentRecall 模型由主进程 [AgentModelService](../../apps/main-2.0/src/main/services/agent-model-service.ts) 调用，模型解析和请求在 [agent-model.ts](../../apps/main-2.0/src/core/agent-model.ts)，读取其他 Agent 在 [agent-model-imports.ts](../../apps/main-2.0/src/core/agent-model-imports.ts)，设置结构在 [agent-model-config.ts](../../apps/main-2.0/src/core/agent-model-config.ts)。renderer 通过[类型化 IPC](../../apps/main-2.0/src/shared/ipc/agent-model.ts)列出服务商和导入项、查询和保存 Key、测试连接。

`providerLibrary` 使用显式版本 1，最多 100 项，记录 UUID、名称、客户端类型、完整配置和凭据引用。凭据保存在既有主进程密钥存储，普通设置中不保存密钥。保存每个修订使用独立凭据引用，元数据写入失败时旧修订仍可读；写入串行化，避免并发保存丢失项目。退出时停止接受配置库操作，等待队列结束后再关闭数据库。通用设置读取和写入排除此库，避免过期设置快照覆盖新记录。不支持的版本或损坏记录报错，不清空重建。

首次读取将原有两套非空自定义配置导入一次，不更改客户端和旧设置。初始化标记保留，因此删除所有项目后不会再次导入。选择服务模板不会自动加载其他同名服务的凭据。设计理由见 [ADR 0009](../adr/0009-named-provider-configurations.md)。

## 失败与验证

保存失败保留编辑草稿；启用失败保留错误和重试入口，不提前展示成功。客户端文件写入与应用设置保存仍属两个步骤；后一步失败不表示客户端文件未写入，需查看当前配置并修复保存错误。

验证入口：[服务与 IPC 测试](../../apps/main-2.0/src/main/services/provider-service.test.ts)、[列表与 AgentRecall 模型交互](../../apps/main-2.0/src/renderer/src/features/providers/provider-page.test.tsx)、编辑与连接测试（[Codex](../../apps/main-2.0/src/renderer/src/features/providers/codex-provider-form.test.tsx)、[Claude Code](../../apps/main-2.0/src/renderer/src/features/providers/claude-provider-form.test.tsx)、[AI 摘要与搜索](../../apps/main-2.0/src/renderer/src/features/providers/summary-provider-form.test.tsx)）、[模型调用测试](../../apps/main-2.0/src/core/agent-model.test.ts)、[导入测试](../../apps/main-2.0/src/core/agent-model-imports.test.ts)、[模型服务测试](../../apps/main-2.0/src/main/services/agent-model-service.test.ts)。测试使用合成配置与隔离环境，导入测试只读取临时目录中的合成 Agent 配置，模型调用测试只连接本机临时端口；不使用开发者真实凭据发起请求。
