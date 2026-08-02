# 修复 Runtime 配置与 Agent 删除校验

## Bug 修复

- 修复离开 Runtime 页面保存执行配置时可能未保留自动生成 Agent 的问题。
- Runtime 不再创建或隐式选择默认 Agent；Chat 和 Workflow 会明确提示从 Agent 列表选择配置，Workflow 的每个 AI 节点在运行前都必须指定 Agent。
- 点击删除 Agent 时会立即按 Agent ID 检查 Chat、任务、团队聊天、团队、Workflow 节点和评估实验的使用关系；存在引用时会保留 Agent 并明确提示所有引用位置。
- Chat 房间支持右键员工并选择删除；删除员工不依赖其 Agent 配置是否仍然存在，也支持删除房间中的最后一名员工。
- 修复执行配置详情内容较长时无法向下滚动、底部配置项无法操作的问题。
