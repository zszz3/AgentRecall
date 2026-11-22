# 专项设计

这里保留具有独立接口和边界说明的专项设计。阅读时先看每篇的状态；底层接口已经实现并不表示桌面已有操作入口。当前模块总览见[功能规格](../spec/README.md)，旧计划与交接见[历史记录](../project/README.md)。

- [Antigravity 只读会话来源](2026-10-14-antigravity-session-source-design.md)：桌面版与 `agy` CLI 本地会话的格式事实、解析契约与两版本接入点。
- [会话经验卡](2026-11-11-session-experience-memory-design.md)：用会话搜索升级与增量经验卡替换 V2 的 OpenViking（已实现）。
- [V2 产品范围与下一步](2026-11-12-v2-product-scope-design.md)：V2 现有功能、保留与删除的取舍、交付顺序（设计草案，待审阅）。
- [V2 个人 Library](2026-11-18-v2-personal-library-design.md)：把个人指令、MCP 服务器、斜杠命令和子 Agent 同步到本机各 Agent 的用户级文件（已实现；MCP、命令与子 Agent 部分将按下一篇删除）。
- [V2 资源与个人、团队范围](2026-11-22-v2-resources-and-scopes-design.md)：AgentRecall 管哪些资源、每种资源在个人和团队两侧放在哪里、两侧之间怎样流动（设计草案，待审阅）。
- [V2 界面重做与交互性能](2026-11-22-v2-ui-redesign-design.md)：统一的字体、字号、颜色和共享组件，各页面的新布局，以及会话搜索和长会话详情的提速（实施中）。
