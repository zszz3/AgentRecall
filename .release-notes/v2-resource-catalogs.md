# Memory、Skills、MCP 和 Provider 页改为清单加详情

<!-- release-target: v2 -->

## 新增功能

- 🗂️ Memory 页改为左侧按项目列出经验卡、右侧显示所选卡片的做法、试过无效的做法和来源轮次，可以按问题、做法或关键词搜索。
- 🎛️ 提炼开关、所用模型和处理进度移到 Memory 页顶部，失败的会话可以展开后单独或全部重试；经验卡由提炼自动维护，页面不再提供编辑，不需要的卡片仍可删除，有用的卡片可以提升为 Skill。
- 🧩 Skills 页把 Skill 库、各个 Agent 目录、团队和云端里的 Skill 合并成一份清单，同名 Skill 只列一次并写出它出现在哪些地方；只在 Agent 或团队里的 Skill 可以一键加入 Skill 库。
- 🔌 MCP 页新增「Agent 与团队」视图，列出 Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Cursor、ZCode 及各个项目里自己配置的 MCP 服务和团队 MCP，可直接用编辑器打开配置文件；环境变量和请求头只显示名称，疑似密钥会被隐藏。
- 🔑 Provider 页改为左侧列出 AgentRecall 模型、AI 摘要与搜索以及 Codex、Claude Code 的各套服务，右侧直接编辑选中的一项。
- 👥 团队的 Skills 和 MCP 回到团队空间各自的标签页编辑，「从 Skill 库添加」「从工具源添加」也在那里；Skills 和 MCP 页只读列出团队条目。
