# 修复远程 Qoder 同步与 Windows 终端问题

## Bug 修复

- 修复开启 Qoder 来源后，同步 SSH 远程机器或 WSL 会话时报错中断的问题；现在可以正常采集远程 Qoder 会话。
- 修复 Windows 上对仍在运行的会话点击 Resume 时报错、无法切换到其所在终端窗口的问题；会话位于 Windows Terminal 后台标签页时也能切换过去。
- 修复 Windows 上终端设为 PowerShell 或命令提示符时，Resume 和迁移后继续对话不会打开终端窗口的问题。
