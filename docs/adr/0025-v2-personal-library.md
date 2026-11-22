# ADR 0025：V2 个人 Library 写入本机 Agent 的用户级文件

## 状态

已采用（V2）。指令部分已实现，MCP、斜杠命令与子 Agent 分阶段跟进。设计见 [V2 个人 Library 设计](../designs/2026-11-18-v2-personal-library-design.md)。

## 背景

用户在多个编码 Agent 里重复维护个人指令、MCP 服务器、斜杠命令和子 Agent。AgentRecall 已经读取这些 Agent 的会话和模型配置，团队空间也已经会把团队配置写进项目文件。个人内容缺少一个统一保存、同步到各 Agent 的地方。

此前 AgentRecall 写入其他 Agent 的文件只有两处：`bin/setup-mcp.cjs` 登记 `agent-recall` MCP 服务器，团队空间把团队配置写进项目里的 `AGENTS.md`、`CLAUDE.md`、`.mcp.json` 等。个人 Library 会写入更多 Agent 的用户级文件，影响用户在所有项目里的使用，所以需要先确定归属和安全规则。

## 决策

- V2 新增个人 Library：在 `~/.agent-recall-v2/library/` 用普通文件保存个人指令、MCP 服务器、斜杠命令和子 Agent，由桌面主进程按每个 Agent 的格式写入它的用户级文件。
- 只写用户级文件，不写项目文件。项目文件仍只由团队空间管理。
- 只改 AgentRecall 写入的部分：指令使用独立的 `agentrecall:library` 标记区块，MCP、命令和子 Agent 只增删 AgentRecall 记录过的条目或文件。记录每个文件上次写入的内容，发现不一致即停下；首次改动文件前先备份。
- 每个 Agent、每一类内容单独开启，默认关闭；写入前显示差异。外部修改了 AgentRecall 的部分时停下并提示，不静默覆盖。关闭或卸载时只撤回 AgentRecall 写入的部分。
- Library 放在主目录而不是 Electron 的 userData：开发版和安装版写的是同一批 Agent 文件，必须共用一份写入记录；卸载脚本也能在不启动应用的情况下找到它。
- Library 读取失败或为空时，不撤回已写入的内容，只报告问题。
- 发现 magpie 已经管理某个文件时，该 Agent 默认不开启。
- 导入只读取原文件，不改动；用户明确选择「从原文件移出」时才在备份后改写原文件。

## 影响

- AgentRecall 第一次修改用户在所有项目中都会生效的文件。错误写入会影响每个会话，因此测试必须覆盖冲突、撤回、空 Library 和回滚，并且只用临时 `HOME`。
- 不复用团队配置的写入代码：它的状态和备份都放在项目根目录，拒绝软链接，按团队清单整体发布；用户级文件常是软链接，且需要按 Agent 单独开关。两者只共享标记区块的写法约定，各自实现。
- 新增「Library」页和 `docs/spec/library.md`。卸载流程增加撤回步骤。
- 各 Agent 的文件位置和格式会变化，AgentRecall 需要跟进；无法识别的格式报告为不支持，不猜测写入。

## 考虑过的替代方案

- **直接推荐使用 magpie。** magpie 已经实现 Library，但它同时接管模型网关和约 90 个 Agent 的配置，范围远大于 AgentRecall 的需要；用户希望在 AgentRecall 里统一管理。两者同时管理同一文件会互相覆盖，所以检测到 magpie 时默认不写。
- **写成软链接指向 Library 文件。** 部分 Agent 不跟随链接，Windows 需要额外权限，并且无法与用户自己的内容共存于同一个文件。
- **整文件覆盖。** 会丢失用户在 Agent 里直接写的内容，不采用。
- **把个人内容放进团队空间的个人仓库。** 团队空间按项目目录安装，不覆盖用户级文件；个人内容也不需要 Git 审核流程。

## 关联

- 规格：[个人 Library](../spec/library.md)。
- 实现：`apps/main-2.0/src/main/services/personal-library-service.ts`、`apps/main-2.0/src/core/library-instructions.ts`、`apps/main-2.0/src/core/library-agents.ts`、`apps/main-2.0/bin/remove-library-blocks.cjs`（卸载撤回）；`apps/main-2.0/bin/setup-mcp.cjs` 的 `agent-recall` 为保留名。
- 相关决策：[ADR 0002 团队资产的受管更新](0002-owned-team-asset-updates.md)。
