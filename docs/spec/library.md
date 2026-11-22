# 个人 Library

范围：V2。个人 Library 保存一份用户自己的指令，写进用户开启的每个本机 Agent 的用户级指令文件，对该 Agent 的所有项目生效。项目文件仍只由 [团队资产](team-assets.md) 管理。归属与安全取舍见 [ADR 0025](../adr/0025-v2-personal-library.md)，后续阶段（MCP、斜杠命令、子 Agent）见 [设计](../designs/2026-11-18-v2-personal-library-design.md)。

## 存放

```text
~/.agent-recall-v2/library/
  instructions.md   指令正文
  state.json        已开启的 Agent、每个文件上次写入的区块内容、已备份过的文件（schemaVersion 1）
  backups/          改动前的原文件，保留最近 30 份
```

放在主目录而不是应用数据目录：开发版和安装版写同一批 Agent 文件，共用一份记录；卸载脚本不启动应用也能找到。`state.json` 的版本未知或无法解析时，任何操作都拒绝执行，不写 Agent 文件。

## 支持的 Agent

| Agent | 用户级指令文件 |
| --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的 `CLAUDE.md` |
| Codex | `$CODEX_HOME` 或 `~/.codex` 下的 `AGENTS.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` |
| OpenCode | `$XDG_CONFIG_HOME` 或 `~/.config` 下的 `opencode/AGENTS.md` |
| Pi | `$PI_CODING_AGENT_DIR` 或 `~/.pi/agent` 下第一个存在的 `AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`，都不存在时为 `AGENTS.md` |
| StepCode | `$STEP_CODING_AGENT_DIR` 或 `~/.stepcode/agent`，规则同 Pi |
| Qwen Code | `$QWEN_HOME` 或 `~/.qwen` 下，文件名取 `settings.json` 的 `context.fileName`（数组取第一个），默认 `QWEN.md` |
| Cursor | 没有用户级指令文件，显示为不支持 |
| DeepSeek Harness | `$DSH_HOME` 或 `~/.dsh` 下的 `AGENTS.md` |
| ZCode | `~/.zcode/AGENTS.md` |

环境变量只接受绝对路径。Codex、Pi、StepCode 存在 `AGENTS.override.md` 时，Agent 只读它，页面提示 Library 内容不会生效，不改写 override 文件。Agent 目录不存在时显示「本机未发现」，仍可开启（文件和目录会被创建）。

## 写入

- Library 的内容写在 `<!-- agentrecall:library begin -->` 与 `<!-- agentrecall:library end -->` 之间，新区块放在文件已有内容之后，用空行隔开。区块外的内容不改动；团队空间的 `agentrecall:team` 区块和 magpie 的区块互不影响。
- 每个 Agent 单独开启，默认关闭。开关前页面先显示改动后的文件内容，确认后才写。
- 第一次改动一个已存在的文件前先备份到 `backups/`（含原路径记录）。写入用临时文件再替换。
- 保存指令后，更新所有已开启 Agent 的文件；指令为空时移除区块。
- 关闭一个 Agent 时移除它的区块；多个 Agent 读同一个文件（例如 Pi 与 StepCode 指向同一目录）时，只要有一个仍开启就保留。
- Library 指令或 `state.json` 读不出来时，所有操作失败并说明原因，不把已写入的区块当成要删除。

## 冲突

`state.json` 记录每个文件上次写入的区块正文。文件中的区块与记录不一致（被手改、被删除、出现多个或标记损坏，或者文件里有 AgentRecall 从未写过的区块）时，这个 Agent 显示「文件里的内容被改过」：

- 保存指令时跳过这个文件，其他 Agent 照常更新。
- 不能直接开关，只能选择：**用文件里的版本**（把文件中的区块正文存为 Library 指令，并同步到其他已开启的 Agent），或 **覆盖文件**（确认后先备份，再写入 Library 的指令）。两种处理都会把这个 Agent 设为开启。

文件中已有 magpie 的区块（`<!-- magpie:begin`）时显示「由 magpie 管理」，拒绝开启，保存时也不写入，避免两个工具来回改同一个文件。

## 导入

「从 Agent 导入」读取所有支持的指令文件，列出区块外的段落（按空行分段，去掉 `agentrecall:*` 和 `magpie:` 区块，空白规整后比较）。相同段落只列一次并标出来自哪些 Agent，已在 Library 中的段落不列出。

用户勾选段落后加入 Library 末尾。勾选「同时从原文件中移出」时，含这些段落的文件先备份，再删掉这些段落，其他内容和所有管理区块保持不变；默认不勾选，原文件不动。有未保存的编辑时不能导入。

## 卸载

`bin/uninstall.cjs` 调用 `bin/remove-library-blocks.cjs`：按 `state.json` 移除区块正文与记录一致的区块，被改过的区块保留并在输出中列出文件；之后把记录中的已开启列表清空。`state.json` 格式未知时报错，不改任何文件。Library 文件本身保留。

## 接口与验证

- 主进程：[personal-library-service.ts](../../apps/main-2.0/src/main/services/personal-library-service.ts)（所有操作串行执行）；区块与段落处理 [library-instructions.ts](../../apps/main-2.0/src/core/library-instructions.ts)；路径解析 [library-agents.ts](../../apps/main-2.0/src/core/library-agents.ts)；IPC 契约 [personal-library.ts](../../apps/main-2.0/src/shared/ipc/personal-library.ts)。
- 页面：[library-page.tsx](../../apps/main-2.0/src/renderer/src/features/library/library-page.tsx)。
- 测试：[personal-library-service.test.ts](../../apps/main-2.0/src/main/services/personal-library-service.test.ts)（写入与撤回、冲突、magpie、Library 读取失败、共用文件、导入）、[library-instructions.test.ts](../../apps/main-2.0/src/core/library-instructions.test.ts)、[library-agents.test.ts](../../apps/main-2.0/src/core/library-agents.test.ts)、[library-page.test.tsx](../../apps/main-2.0/src/renderer/src/features/library/library-page.test.tsx)、[remove-library-blocks.test.mjs](../../apps/main-2.0/scripts/remove-library-blocks.test.mjs)、[uninstall.test.mjs](../../apps/main-2.0/scripts/uninstall.test.mjs)。全部使用临时 `HOME` 和合成文件。

| 验收场景 | 期望 |
| --- | --- |
| 开启 Claude Code | 先显示改动后的内容；确认后区块写在已有内容之后，原文件已备份 |
| 修改并保存指令 | 已开启的文件更新，未开启的不变 |
| 手改了区块后保存 | 该文件不变并显示冲突，其他 Agent 更新 |
| 文件含 magpie 区块 | 拒绝开启 |
| `instructions.md` 读不出来 | 操作失败，已写入的区块保留 |
| 导入并移出 | 段落进入 Library；原文件备份后只删掉这些段落 |
| 卸载 | 未被改过的区块移除，被改过的保留并列出 |
