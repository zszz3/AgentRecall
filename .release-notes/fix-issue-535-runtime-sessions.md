# 归类 AgentRecall 发起的 Runtime 会话

<!-- release-target: v2 -->

## Bug 修复

- AgentRecall 发起的 Codex、Claude Code、Hermes、OpenCode、OpenClaw 与 DeepSeek Harness 会话现在归入默认收起的独立分组，可按 Workflow、Eval、Team Chat、Agent、Skill 和系统任务筛选，不再挤占普通会话列表。
- Session 详情和业务记录现在提供双向入口，并明确区分 Runtime 未返回 Session 引用、Session 尚未完成索引和没有调用记录。
