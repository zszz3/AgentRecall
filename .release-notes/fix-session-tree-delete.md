# 修复会话树删除残留

## Bug 修复

- 删除带有 Subagent 的 Claude Code、Codex 或 ZCode 主会话时，现在会一并清理关联子会话；Claude Code 与 Codex 的关联文件也会同步移除，ZCode 会话不会再以“New session”幽灵条目重新出现。
- 会话列表新增孤儿 Subagent 清理入口，可在确认影响数量后移除历史遗留的孤儿会话。
