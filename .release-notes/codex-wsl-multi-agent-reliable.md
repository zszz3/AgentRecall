# WSL 多 Agent 会话支持

<!-- release-target: both -->

## 新增功能

- WSL 发行版现在可以发现并管理 Claude Code、Codex、TClaude、TCodex 和 CodeBuddy 会话，支持详情、Resume、手动云备份，以及带目标 Linux 项目目录校验的跨环境迁移。
- WSL 发行版选择器现在显示默认发行版、运行状态和 WSL 版本；已有 Qoder、OpenCode、CodeWiz 格式的会话也可以在 WSL 中读取和搜索。
- WSL 诊断现在会逐项检查运行时、CLI、会话目录、HOME 写权限和监听工具，并给出适用于已识别包管理器的修复命令。
- WSL 监听在发行版重启或监听工具不可用时会自动退回轮询，并在恢复后重新尝试事件监听，界面会显示实际同步模式。
- WSL 轮询回退间隔可以在设置中调整，监听恢复会使用有界指数退避，全文索引支持取消并显示耗时。

## Bug 修复

- 修复 WSL Resume 使用 Windows CLI 路径、云端恢复绑定到错误同名会话，以及临时传输失败导致全文索引长期不更新的问题。
- 修复 SSH 在 PowerShell 中继续会话时误用本机 CLI 路径，以及同一 WSL 发行版内迁移忽略所选项目目录或无项目路径选项的问题。
