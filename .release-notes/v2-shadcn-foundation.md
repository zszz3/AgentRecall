# 会话详情新增运行轨迹和上下文曲线

<!-- release-target: v2 -->

## 新增功能

- 🧭 会话详情默认显示「轨迹」：按轮次逐行列出你的提问、模型的每一步和每次工具调用，可以折叠轮次、调用和子调用，也可以搜索；点开一行会显示完整的输入和输出。
- 📈 新增「上下文」页签：用曲线显示每次模型调用发送的上下文大小，标出缓存读取、新写入和压缩；一屏约显示 100 轮，可以左右滚动和缩放，点击曲线会跳到对应轮次的轨迹。轨迹顶部也会显示这条曲线的缩略版。
- 📋 Session 列表改为单行显示：每个会话用对应 Agent 的图标标出来源，并显示项目、消息数、Token 用量和时间。
- 🏝️ 新增顶部「灵动岛」实时任务提醒：支持 DeepSeek Harness Desktop 等桌面端应用与 Claude Code、Codex、Pi 等终端 Agent，回复完成、等待确认或执行异常时在屏幕顶部非抢焦点提醒，支持前台防打扰、一键切回原应用、直达轨迹与分享到团队，可在「设置 → 外观」和工作台随时开关或测试。
- 🔀 「Provider」页升级为「网关」：保留原有的 AgentRecall 模型、AI 摘要与搜索、Codex 和 Claude Code 直连配置，新增可选本地模型网关（默认 `127.0.0.1:4325`，默认关闭），支持 OpenAI Chat / Responses 与 Anthropic Messages 协议互转、多上游 Fallback、实时请求记录，以及为 Claude Code、Codex、DeepSeek Harness、Pi、OpenCode 一键写入配置并无损还原。
- 🔌 新安装默认读取 Gemini CLI、DeepSeek Harness、Pi 和 ZCode 的会话，可以在「设置 → 可选来源」中关闭。
- 🔤 界面改用系统字体和中性灰配色，选中状态不再使用彩色背景。

## Bug 修复

- 修复 DeepSeek Harness 和 ZCode 会话中已完成的工具调用一直显示「进行中」的问题，并补上 DeepSeek Harness 只调用工具、没有写回复的模型步骤。
- 子 Agent 会话列表默认折叠，不再挤占会话详情的对话区域；没有回复的轮次不再显示「0ms」。
