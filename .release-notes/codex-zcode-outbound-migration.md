# ZCode 会话支持迁移到其他 Agent
<!-- release-target: both -->

## 新增功能

- 支持将本地 ZCode 会话迁移到 Claude Code、Codex 等 Agent，延续已有对话；桌面端迁移时可保留子会话关系，原会话保持不变。

## Bug 修复

- 修复迁移到部分 Agent 后子会话变成独立会话的问题，保留多级父子关联。
