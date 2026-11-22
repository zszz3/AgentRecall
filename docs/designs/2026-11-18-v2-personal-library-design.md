# V2 个人 Library 设计

## 文档状态

- 状态：第 2 阶段（指令）已实现，当前行为见 [个人 Library 规格](../spec/library.md)；第 3、4 阶段待实现。
- 适用范围：`apps/main-2.0`。V1 不做。
- 决策记录：[ADR 0025](../adr/0025-v2-personal-library.md)。
- 依据：本机 10 个 Agent 的用户级文件现状、magpie（`learn-agent/magpie`，MIT）`internal/library` 的实现，以及 AgentRecall 现有的团队配置写入（`packages/workspace-core/src/project-configuration.ts`）。

## 要解决的问题

同一个人会同时用 Claude Code、Codex、Gemini CLI、OpenCode、Pi 等多个 Agent。个人习惯（“回答用中文”“提交信息用英文”）、常用 MCP 服务器、斜杠命令和子 Agent 要在每个 Agent 里各写一遍，格式各不相同，改一处忘一处。

个人 Library 把这些内容在 AgentRecall 里保存一份，按每个 Agent 自己的格式写进它的**用户级**文件，并能从这些文件导入已有内容。

不做：

- 不写项目文件（项目里的 `AGENTS.md`、`.mcp.json` 等由团队空间管理）。
- 不做模型服务的切换或网关（这是 magpie 的主业，AgentRecall 只导入模型服务给自己用）。
- 不做 Skill：Skill 已经由 Skills 页安装到各 Agent。

## 支持的 Agent 与位置

第一版覆盖本机已安装或已有会话来源的 10 个 Agent。路径都是用户级位置；括号里是改变位置的环境变量。

| Agent | 指令文件 | MCP 服务器 | 斜杠命令 | 子 Agent |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md`（`CLAUDE_CONFIG_DIR`） | `~/.claude.json` 的 `mcpServers` | `~/.claude/commands/*.md` | `~/.claude/agents/*.md` |
| Codex | `~/.codex/AGENTS.md`（`CODEX_HOME`）；存在 `AGENTS.override.md` 时 Codex 只读它，页面提示 | `config.toml` 的 `[mcp_servers.<名称>]` | 不支持 | `~/.codex/agents/*.toml` |
| Gemini CLI | `~/.gemini/GEMINI.md` | `~/.gemini/settings.json` 的 `mcpServers` | `~/.gemini/commands/*.toml` | `~/.gemini/agents/*.md` |
| OpenCode | `~/.config/opencode/AGENTS.md`（`XDG_CONFIG_HOME`） | `opencode.json` 的 `mcp` | `~/.config/opencode/commands/*.md` | `~/.config/opencode/agents/*.md` |
| Pi | `~/.pi/agent/` 下第一个存在的 `AGENTS.md`、`CLAUDE.md`（`PI_CODING_AGENT_DIR`） | `mcp.json` 的 `mcpServers` | `~/.pi/agent/prompts/*.md` | 不支持 |
| StepCode | `~/.stepcode/agent/` 下同 Pi 的规则（`STEP_CODING_AGENT_DIR`） | 不支持 | 不支持 | 不支持 |
| Qwen Code | `~/.qwen/QWEN.md`（`QWEN_HOME`；`context.fileName` 可改名） | 不支持 | `~/.qwen/commands/*.md` | `~/.qwen/agents/*.md` |
| Cursor | 无用户级指令文件 | `~/.cursor/mcp.json` 的 `mcpServers` | 不支持 | `~/.cursor/agents/*.md` |
| DeepSeek Harness | `$DSH_HOME/AGENTS.md`（默认 `~/.dsh`） | 第 3 阶段再定（见下文） | 不支持 | 不支持 |
| ZCode | `~/.zcode/AGENTS.md` | `~/.zcode/cli/config.json` 的 `mcp.servers` | 不支持 | 不支持 |

“不支持”表示该 Agent 没有可以写入的用户级位置，页面显示原因，不写入。

MCP 服务器在各家的写法不同，第 3 阶段按下面的映射编码和解析：

| 格式 | stdio | 远程 |
| --- | --- | --- |
| Claude Code、ZCode | `type` + `command` + `args` + `env` | `type`（`http`/`sse`）+ `url` + `headers` |
| Codex | `command` + `args` + `env`；引用环境变量的值写入 `env_vars` | `url` + `http_headers`；`Authorization: Bearer ${X}` 写成 `bearer_token_env_var` |
| Gemini CLI | `command` + `args` + `env` | Streamable HTTP 用 `httpUrl`，SSE 用 `url` |
| OpenCode | `type: "local"`，`command` 为命令加参数的数组，`environment` | `type: "remote"` + `url` + `headers`；都带 `enabled: true` |
| Cursor、Pi | `command` + `args` + `env` | `url` + `headers` |

DeepSeek Harness 没有 MCP 文件：每个服务器是各配置档 `cordis.patch.yml` 中插入的一行 `@deepseek-ai/dsh-mcp-client` 插件。它需要单独的 YAML 编辑，第 3 阶段再决定是否支持。

## 数据存放

Library 内容是用户自己写的文本，放在普通文件里，方便直接查看和备份：

```text
~/.agent-recall-v2/library/
  instructions.md        个人指令正文
  mcp.json               MCP 服务器列表
  commands/<名称>.md      斜杠命令，front matter 写 description
  agents/<名称>.md        子 Agent，front matter 写 name、description、可选 model
  state.json             每个 Agent 开关与已写入内容的记录
```

`state.json`（`schemaVersion: 1`）记录每个 Agent 是否开启每一类内容，以及 AgentRecall 上次写入每个文件的内容摘要。未知版本加载失败并提示，不覆盖。

## 写入规则

Library 放在主目录，开发版和安装版共用同一份写入记录，卸载脚本不启动应用也能找到。写入不复用团队配置的 `project-configuration.ts`：那套机制的状态和备份绑定项目根目录、拒绝软链接、按团队清单整体发布，而用户级文件常是软链接、需要按 Agent 单独开关。两者只共享标记区块的写法约定：

- **只改自己的部分。** 指令写在 `<!-- agentrecall:library begin -->` 与 `<!-- agentrecall:library end -->` 之间，新区块放在用户已有内容之后；它与团队配置的 `agentrecall:team` 标记不同，两者互不影响。MCP 只增删 AgentRecall 记录过的条目；斜杠命令和子 Agent 只写、只删 AgentRecall 记录过的文件。
- **外部改动时停下。** 文件里属于 AgentRecall 的部分与上次写入的记录不一致，或同名 MCP 条目、同名命令文件不是 AgentRecall 写的，这个 Agent 的这一类内容不写入，页面显示冲突和处理方式（采用文件里的版本，或覆盖并备份）。不会静默覆盖。
- **每个 Agent 单独开启。** 默认全部关闭。开启前显示将要写入的差异；确认后才写。
- **先备份。** 每次改动文件前把原文件复制到 `~/.agent-recall-v2/library/backups/`，保留最近 30 份。写入用临时文件加替换，失败时恢复原文件。
- **关闭即撤回。** 关闭某个 Agent 或某一类内容，只删除 AgentRecall 写入的部分。卸载 AgentRecall 时同样撤回（`bin/uninstall.cjs` 调用）。
- **空 Library 不清空。** Library 文件读取失败或意外为空时，不把已写入的部分当成“要删除”，只报告问题；只有用户在页面上删除内容或关闭开关才撤回。这对应 magpie 遇到过的升级后清空九个 Agent 指令文件的问题。
- **多个 Agent 共用一个文件时**（例如 Pi 和 StepCode 都可能读到同一个 `CLAUDE.md` 链接），只要有一个开启就保留区块。
- **magpie 已在管理时不写。** 文件中已有 `<!-- magpie:begin` 区块，或 MCP 文件中已有 magpie 写入的条目时，该 Agent 默认不开启并提示，避免两个工具来回改同一处。

AgentRecall 已经在 Claude Code 和 Codex 的 MCP 配置里登记 `agent-recall` 服务器（`bin/setup-mcp.cjs`）。Library 把这个名称视为保留名，不导入、不覆盖。

## 导入

导入从各 Agent 的上述位置读取已有内容，合并到 Library，**不改动原文件**：

- 指令：读取每个指令文件中不属于任何管理区块的正文（去掉 `agentrecall:*` 和 `magpie:*` 区块）。多个 Agent 的相同段落只保留一次；不同段落按来源分节列出，由用户选择要保留的段落。
- MCP 服务器：按名称和内容去重；同名但内容不同时列为冲突，由用户选择。引用环境变量的值保留为引用，不展开成实际值。
- 斜杠命令和子 Agent：按文件名去重，参数写法转换成 Library 的统一写法（`$ARGUMENTS`）。

导入后可以勾选「从原文件移出」：原文件先备份，再删掉已移入 Library 的内容，换成 AgentRecall 的区块。默认不勾选。

## 界面

新增「Library」页（侧边栏，位于 Skills 之后），四个标签：指令、MCP、命令、子 Agent。每个标签上方是 Library 的内容编辑，下方是 Agent 列表：安装状态、开关、同步状态（已同步、待写入、冲突、不支持），以及「从 Agent 导入」。

## 分阶段交付

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | AgentRecall 模型从 CC Switch、Pi、StepCode、OpenCode 导入 | 已合并（PR #646） |
| 2 | Library 存储与页面；指令的导入、写入、撤回 | 已实现 |
| 3 | MCP 服务器（含 DeepSeek Harness 是否支持的决定） | 待开始 |
| 4 | 斜杠命令与子 Agent | 待开始 |

每个阶段单独提交 PR，带测试、规格（新增 `docs/spec/library.md`）和发布说明。

## 测试

- Library 写入测试使用临时 `HOME` 和合成文件，覆盖：首次写入与备份、更新、外部修改时停下、关闭撤回、空 Library 不清空、magpie 区块存在时不开启、写入失败回滚。
- 每个 Agent 的路径解析覆盖环境变量改位置、文件不存在、Pi 的“第一个存在的文件”。
- 不读取或修改开发者真实的 Agent 配置。

## 待定问题

- DeepSeek Harness 的 MCP 是否在第 3 阶段支持（需要编辑 YAML 插件行，并处理多个配置档）。
- 是否允许不同 Agent 使用不同的指令（magpie 支持“指令集”和按 Agent 追加内容）。已决定：第一版只有一份，所有开启的 Agent 写入相同内容。
- Codex 没有斜杠命令目录；是否把命令写成 Codex 的 Skill。已决定：第一版不写。
