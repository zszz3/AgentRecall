# 目录 Memory 的移除与旧数据清理

范围：V2。V2 不提供目录 Memory，也没有其他长期记忆功能；复用历史做法通过 [会话搜索](knowledge-search.md) 完成。个人 Skills 设置中的 Memories 文件同步是另一项功能，见 [Skills](skills.md)。移除原因见 [ADR 0022](../adr/0022-remove-v2-directory-memory.md)。

本规格描述早期版本留下的 Hook、数据库记录和磁盘数据如何处理。

## 数据库记录

[PostgreSQL 迁移](../../apps/main-2.0/src/core/postgres/schema.ts) 63 删除全部 `openviking_*` 表，包括目录映射、人工编辑、反馈、提交和召回记录。数据不导出，迁移只向前执行。

设置文件中的 `openViking*` 字段在加载时忽略，下次保存时不再写出。设置里没有摘要推理强度时，从旧的提炼推理强度继承一次。

## 编码客户端 Hook

早期版本把记忆 Hook 写入 `~/.claude/settings.json` 和 `~/.codex/hooks.json`，并在 `~/.config/opencode/plugins/agent-recall-openviking.js` 写入引用安装目录插件的包装文件。

[清理脚本](../../apps/main-2.0/bin/remove-legacy-memory-hooks.cjs)在桌面每次启动和执行卸载命令时运行：

- 只删除命令指向 AgentRecall 记忆 Hook 的条目；删空的事件和 `hooks` 对象一并删除，其他条目、字段和格式之外的内容保持不变。
- OpenCode 包装文件只在内容引用 AgentRecall 记忆插件时删除。
- 配置文件不存在时不创建；无法解析时报告错误并保持文件不变。
- 再次运行不产生变化。

桌面启动时清理失败只记录日志，不阻止启动。

升级后到首次启动前，客户端仍会调用旧 Hook。安装包为此保留两个存根：[Hook 脚本](../../apps/main-2.0/bin/openviking-memory-hook.cjs)立即以 0 退出且不读写任何文件，[OpenCode 插件](../../apps/main-2.0/bin/openviking-opencode-plugin.mjs)返回空插件。

## 磁盘上的旧数据

`<userData>/openviking` 保存过运行组件、向量模型和记忆数据，不会自动删除。

| 状态 | 设置 → AI 中的表现 |
| --- | --- |
| 目录不存在 | 不显示任何内容 |
| 目录存在 | 显示「旧记忆数据」与占用空间，提供删除按钮 |
| 删除中 | 按钮不可用；重复请求共享同一次删除 |
| 删除失败 | 显示错误，可再次删除 |
| 删除成功 | 该行消失 |

删除需要用户在确认框中确认，由主进程的 [旧数据服务](../../apps/main-2.0/src/main/services/legacy-memory-data-service.ts)执行：删除目录后再删除 `~/.agent-recall-v2/openviking-manifest-path` 指针。统计大小和删除都不跟随符号链接，链接指向的文件保持不变。

## 验收场景

| 场景 | 期望结果 |
| --- | --- |
| 配置中同时有 AgentRecall 记忆 Hook 和其他 Hook | 只删除 AgentRecall 的条目 |
| 配置文件不是合法 JSON | 报告错误，文件不变 |
| 同名 OpenCode 插件文件不是 AgentRecall 写入的 | 文件保留 |
| 首次启动前旧 Hook 被调用 | 以 0 退出，无输出 |
| 旧数据目录包含指向外部的符号链接 | 外部文件不计入大小，删除后仍存在 |
| 删除进行中再次点击 | 不发起第二次删除 |
| 删除失败后重试 | 再次执行删除 |

## 验证入口

[Hook 清理测试](../../apps/main-2.0/scripts/remove-legacy-memory-hooks.test.mjs)、[旧数据服务测试](../../apps/main-2.0/src/main/services/legacy-memory-data-service.test.ts)、[设置行测试](../../apps/main-2.0/src/renderer/src/features/settings/legacy-memory-data-settings.test.tsx)、[迁移测试](../../apps/main-2.0/src/core/postgres/schema.test.ts)。
