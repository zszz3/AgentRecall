# 归类 AgentRecall 发起的 Runtime 会话

<!-- release-target: v2 -->

## 新增功能

- AgentRecall 发起且由 Runtime 返回可靠 Session 引用的会话现在可通过“普通会话”右侧的“AgentRecall 调用”切换项单独查看，并可从切换项的折叠菜单按 `workflow`、`eval`、`chat`、`agent`、`skill` 和 `system` 类型筛选，不再挤占普通会话列表；用量和项目计数也采用相同口径。
- Session 详情和 Workflow、Eval、Team Chat 业务记录现在提供精确的双向入口；Runtime 未返回 Session 引用时会保留调用记录并明确说明，不再根据目录变化、标题、路径或时间猜测归属。
