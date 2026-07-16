# 会话自动同步 Hook 设计

## 范围

- Supabase 会话同步与 Skill 同步继续使用两个独立设置区。
- 仅为本地 Claude Code 与 Codex 会话增加自动同步 Hook；Skill 同步保持手动。
- 不自动覆盖冲突，不自动删除本地或云端内容。

## 设置交互

- “启用远程会话同步”位于会话同步设置区顶部。
- 关闭时隐藏 URL、anon key、初始化 SQL 与 Hook 管理；已保存的连接信息和云端数据保留。
- 关闭前移除本应用安装的会话 Hook；移除失败则保持开启并显示错误。
- 开启后显示连接配置和 Hook 状态。用户可独立安装或移除 Hook，未安装 Hook 时仍可手动上传与恢复。

## Hook 与同步流程

- Claude Code 和 Codex 均使用 `Stop` Hook，在每轮回复完成后触发。
- Hook 只把 agent、session id、transcript path 与触发时间写入本地事件目录，不读取 Supabase key，也不执行网络请求。
- 常驻托盘的 App 定期消费事件：先刷新本地索引，再定位会话，排除子智能体会话，最后调用现有 revision/冲突检查上传。
- 相同会话的多个事件合并为一次；已同步 revision 不重复上传。
- App 未运行时事件保留到下次启动。网络失败保留事件重试；内容冲突停止自动重试，交给同步界面人工处理。

## 安装与清理

- 安装器只合并本应用的 Hook，保留用户已有配置。
- Codex Hook 写入用户级 `hooks.json`，安装后提示用户在 `/hooks` 中审查并信任。
- “移除 Hook”、关闭会话同步以及 `agent-recall uninstall` 都只删除本应用的 Hook 与待处理事件。

## 验证

- 所有安装、触发与卸载测试使用临时 HOME。
- 覆盖 Claude/Codex 配置保留、幂等安装、移除、事件写入、重复事件去重、子智能体过滤、失败重试和关闭时清理。
