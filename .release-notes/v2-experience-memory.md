# Memory 改为经验卡，会话搜索可定位到轮次

<!-- release-target: v2 -->

## 新增功能

- 新的 Memory 页可以从开启后新完成的会话中提炼踩坑经验和决策，按项目保存成经验卡；默认关闭，需要先设置 AgentRecall 模型才能开启。
- Provider 页新增「AgentRecall 模型」：选择 DeepSeek、OpenAI、Anthropic 等服务商的模型或填写自定义接口，保存 API Key 并一键测试。经验卡提炼和 AI 探索 Skill 直接调用这个模型，不启动编码 Agent，也不会产生额外的会话。
- AI 探索 Skill 改用 AgentRecall 模型，不再需要先在 Runtime 中准备 Agent；之前选择的探索 Runtime 不再使用，请在「Provider → AgentRecall 模型」中设置模型。
- 经验卡可以搜索、编辑、确认后删除，并能一键打开来源会话的对应轮次；被新做法取代的卡片默认隐藏，可选择显示。
- Memory 页显示处理进度、失败原因和 Token 用量，失败的会话可以单独或全部重试。
- 🔍 搜索多个关键词时，这些词分布在同一会话的不同轮次也能找到该会话，不再要求出现在同一轮。
- 🧭 Agent 通过 MCP 或命令行搜索本机会话时，会先看到相关的经验卡，再看到匹配的会话；结果会列出命中的轮次和片段，并可直接从命中的轮次开始读取原文。
- 旧的目录记忆已停用，不再在后台运行记忆组件或通过 Hook 采集对话。
- 升级后启动应用会自动移除早期版本为 Claude Code、Codex 和 OpenCode 写入的记忆 Hook，不影响你自己配置的其他 Hook。
- 早期版本下载的记忆组件和数据不会自动删除；可在「设置 → AI」中查看「旧记忆数据」的占用空间，确认后一键删除。

## Bug 修复

- Hermes、OpenCode、OpenClaw Agent 绑定了限制工具的 MCP 时，会话会提示无法限制工具并停止启动，不再把该 MCP 的全部工具交给 Agent。
