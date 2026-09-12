# WSL 多 Agent 会话支持

<!-- release-target: both -->

## 新增功能

- WSL 发行版现在可以发现并管理 Claude Code、Codex、TClaude、TCodex 和 CodeBuddy 会话，支持详情、Resume、手动云备份，以及带目标 Linux 项目目录校验的跨环境迁移。
- WSL 监听在发行版重启或监听工具不可用时会自动退回轮询，并在恢复后重新尝试事件监听，界面会显示实际同步模式。

## Bug 修复

- 修复 WSL Resume 使用 Windows CLI 路径、云端恢复绑定到错误同名会话，以及临时传输失败导致全文索引长期不更新的问题。
