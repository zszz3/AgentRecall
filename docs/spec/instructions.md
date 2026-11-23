# 指令

范围：V2。「指令」页把本机 Agent 会读取的指令文件都找出来，只读展示，并能用系统默认编辑器打开或在文件夹中显示。AgentRecall 不编辑、不同步这些文件：指令通常由 Agent 和人直接维护，页面的作用是让人看清每个 Agent、每个项目到底读了什么。取舍见 [ADR 0026](../adr/0026-v2-resource-catalogs.md)；页面布局见 [资源目录设计](../designs/2026-11-23-v2-resource-catalogs-design.md)。

## 查找范围

| 范围 | 位置 |
| --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的 `CLAUDE.md` |
| Codex | `$CODEX_HOME` 或 `~/.codex` 下的 `AGENTS.md` 与 `AGENTS.override.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` |
| OpenCode | `$XDG_CONFIG_HOME` 或 `~/.config` 下的 `opencode/AGENTS.md` |
| Pi | `$PI_CODING_AGENT_DIR` 或 `~/.pi/agent` 下第一个存在的 `AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`，以及 `AGENTS.override.md` |
| StepCode | `$STEP_CODING_AGENT_DIR` 或 `~/.stepcode/agent`，规则同 Pi |
| Qwen Code | `$QWEN_HOME` 或 `~/.qwen` 下，文件名取 `settings.json` 的 `context.fileName`（数组取第一个），默认 `QWEN.md` |
| DeepSeek Harness | `$DSH_HOME` 或 `~/.dsh` 下的 `AGENTS.md` |
| ZCode | `~/.zcode/AGENTS.md` |
| 项目 | 本机有会话、且目录仍存在的项目根目录下的 `AGENTS.md`、`AGENTS.override.md`、`CLAUDE.md`、`CLAUDE.local.md`、`GEMINI.md`、`QWEN.md`、`.cursorrules`、`.github/copilot-instructions.md` 与 `.cursor/rules/*.md(c)` |
| 团队 | 已连接团队的共享指令（团队开启时） |

环境变量只接受绝对路径。只列出存在的文件；同一个文件经符号链接出现在多个路径时只列一次，其余路径显示为「也是 …」，多个 Agent 读同一个文件时合并显示。远程环境（SSH、WSL）的项目不查找。

## 页面

- 顶部一行：标题、文件数与项目数、搜索框（按文件名、路径、Agent、项目匹配，团队指令也按正文匹配）、重新查找。
- 左侧列表分组：「Agent 用户级」、每个项目一组、每个团队一组。空文件标「空」。
- 右侧详情：文件名、完整路径、读取它的 Agent 或所属项目、其他路径、大小、修改时间，下方是 Markdown 预览（超过 60,000 字符截断，大于 1 MB 的文件不读取，提示用编辑器打开）。按钮「用编辑器打开」「在文件夹中显示」。
- 团队指令只读：显示写入的文件（`AGENTS.md`、`CLAUDE.md`）和正文，「去团队空间编辑」打开团队空间，编辑与 Push 都在那里完成。

## 安全

- 主进程只对最近一次列出的文件（及其别名路径）执行读取、打开和显示；请求的路径不在列表中时先重新查找一次，仍不在则拒绝：「<文件名> is not one of the instruction files any more. Refresh the list and try again.」。渲染进程不能借此读取任意文件。
- 打开失败时显示系统给出的原因：「Could not open <文件名>: <原因>」。

## 早期版本写入的内容

早期版本的「指令」页（以及更早的 Library）会把一份个人指令写进各 Agent 的用户级文件，夹在 `<!-- agentrecall:library begin -->` 与 `<!-- agentrecall:library end -->` 之间，并在 `~/.agent-recall-v2/library/` 保存记录。这项功能已删除：AgentRecall 不再写入、收回或在卸载时移除这些区块，留下的区块作为普通文本出现在文件预览中，需要时用编辑器删掉；`~/.agent-recall-v2/library/` 不再使用，可以直接删除。

## 接口与测试

- 查找：[instruction-files.ts](../../apps/main-2.0/src/core/instruction-files.ts)；只允许访问已列出文件：[instruction-catalog-service.ts](../../apps/main-2.0/src/main/services/instruction-catalog-service.ts)；IPC `instructions:list`、`instructions:read`、`instructions:open`、`instructions:reveal`（[instructions.ts](../../apps/main-2.0/src/shared/ipc/instructions.ts)）。
- 页面：[instructions-page.tsx](../../apps/main-2.0/src/renderer/src/features/instructions/instructions-page.tsx)，通用目录布局 [catalog.tsx](../../apps/main-2.0/src/renderer/src/ui/catalog.tsx)，团队内容读取 [use-team-catalogs.ts](../../apps/main-2.0/src/renderer/src/features/team-workspace/use-team-catalogs.ts)。
- 测试：[instruction-files.test.ts](../../apps/main-2.0/src/core/instruction-files.test.ts)、[instruction-catalog-service.test.ts](../../apps/main-2.0/src/main/services/instruction-catalog-service.test.ts)、[instructions-page.test.tsx](../../apps/main-2.0/src/renderer/src/features/instructions/instructions-page.test.tsx)，全部使用临时目录或模拟接口，不读写真实的 Agent 配置。

## 验收场景

| 场景 | 预期 |
| --- | --- |
| `~/.claude/CLAUDE.md` 存在 | 列在「Agent 用户级」，标题 Claude Code |
| 项目的 `CLAUDE.md` 是指向 `AGENTS.md` 的符号链接 | 只列一个 `AGENTS.md`，显示「也是 CLAUDE.md」 |
| 有会话的项目目录已删除 | 不列出，也不报错 |
| 选中文件 | 右侧预览正文；没有编辑框 |
| 点「用编辑器打开」 | 用系统默认程序打开文件 |
| 渲染进程请求未列出的路径 | 拒绝，不读取 |
| 选中团队指令 | 显示正文，「去团队空间编辑」打开团队空间 |
