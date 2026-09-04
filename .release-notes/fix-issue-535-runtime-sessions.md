# 归类 AgentRecall 发起的 Runtime 会话

<!-- release-target: v2 -->

## Bug 修复

- AgentRecall 发起且由 Runtime 返回可靠 Session 引用的会话现在归入默认收起的独立分组，可按 Workflow、Eval、Team Chat、Agent、Skill 和系统任务筛选，不再挤占普通会话列表；用量和项目计数也采用相同口径。
- Session 详情和 Workflow、Eval、Team Chat 业务记录现在提供精确的双向入口；Runtime 未返回 Session 引用时会保留调用记录并明确说明，不再根据目录变化、标题、路径或时间猜测归属。
