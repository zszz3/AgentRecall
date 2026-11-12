# ADR 0022：V2 移除目录 Memory，升级时删除其记录

## 状态

已采用，适用于 V2。替代 [ADR 0006](0006-directory-memory-opt-in.md)。

## 背景

目录 Memory 依靠 Claude Code、Codex 和 OpenCode 的 Hook 把新对话写入独立的 OpenViking 服务，再由模型提炼成长期记忆并在会话开始时召回。实际使用中：

- 召回请求约 30 次，被注入到 Agent 上下文的结果为 0 次。
- 采集只覆盖装了 Hook 的客户端。近 30 天约 73% 的会话没有进入记忆，主要因为 DeepSeek Harness、ZCode 等来源没有 Hook；而 AgentRecall 的会话索引已经覆盖全部来源。
- 运行组件是单独打包的 CPython 服务和本地向量模型，用户数据目录中可达数 GB；发布流程要为三个平台构建、指纹校验和复用这套运行包。
- 相关代码约 2 万行，包括十余个主进程服务、Hook 与 OpenCode 插件、发布脚本和专属数据表，维护成本与实际收益不成比例。

复用历史经验的方向改为基于已索引会话：先提升会话搜索，再另行设计从会话提炼的经验记录。

## 决策

- 删除目录 Memory 的页面、设置、工作台卡片、主进程服务与 IPC、MCP 记忆工具、OpenViking 运行包的构建与发布步骤，以及 `@openviking/sdk` 依赖。
- PostgreSQL 迁移 63 删除全部 `openviking_*` 表。目录映射、人工编辑和反馈记录不导出。迁移只向前执行。
- 设置文件中的 `openViking*` 字段在加载时忽略、下次保存时不再写出；只在缺少摘要推理强度时，从旧的提炼推理强度继承一次。
- 桌面每次启动和 `agent-recall-v2 --uninstall` 都会移除早期版本写入 `~/.claude/settings.json`、`~/.codex/hooks.json` 的记忆 Hook 和 OpenCode 插件包装文件；只匹配 AgentRecall 自己的命令或标记，其他条目不动，配置文件无法解析时报告错误而不改写。
- 旧 Hook 命令和 OpenCode 包装文件指向安装目录中的脚本，升级后到首次启动前仍会被客户端调用。安装包因此保留两个无副作用的存根：Hook 脚本立即以 0 退出，OpenCode 插件返回空插件。不再支持从装过这些 Hook 的版本直接升级时删除存根。
- `<userData>/openviking` 不自动删除。目录存在时，设置中显示其占用空间，用户确认后由主进程删除该目录和 `~/.agent-recall-v2/openviking-manifest-path` 指针；删除不跟随符号链接，失败可重试。

## 影响

- 升级后 Memory 页面消失，已有目录记忆无法再查看或召回；会话本身仍在 Session 搜索中。
- 降级到移除前的版本时，相关表已不存在，旧版本的目录 Memory 需要重新准备；V2 是预览版，不提供该方向的兼容。
- 用户在升级后首次启动前使用编码客户端时，旧 Hook 调用存根，不报错也不写入任何数据。

## 考虑的替代方案

- 保留功能并为更多客户端补 Hook：仍无法覆盖没有 Hook 机制的来源，召回为 0 的问题也不会因采集更多而解决，未采用。
- 只隐藏入口：运行组件、发布流程和数据表仍需维护，Hook 仍在用户客户端中运行，未采用。
- 升级时自动删除 `<userData>/openviking`：目录可能很大，且是用户此前下载的数据，删除需要用户明确确认。

## 关联

[Memory 规格](../spec/memory.md)、[PostgreSQL 迁移](../../apps/main-2.0/src/core/postgres/schema.ts)、[Hook 清理](../../apps/main-2.0/bin/remove-legacy-memory-hooks.cjs)、[旧数据删除服务](../../apps/main-2.0/src/main/services/legacy-memory-data-service.ts)。
