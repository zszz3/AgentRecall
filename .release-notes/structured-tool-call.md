# Codex Code Mode 工具记录更准确

<!-- release-target: both -->

## 新增功能

- Codex Code Mode 会话现在可展示内部实际调用的工具，并更准确地统计已读取或执行的 Skill；仅在代码中出现、执行失败或被拒绝的调用不会误计为成功使用。

## Bug 修复

- 修复应用目录与系统临时目录位于不同磁盘时，V2 无法修复缺失的 Electron runtime、导致启动失败的问题。
