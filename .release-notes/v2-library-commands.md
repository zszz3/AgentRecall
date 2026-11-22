# Library 同步斜杠命令和子 Agent
<!-- release-target: v2 -->

## 新增功能

- 📚 个人 Library 新增「斜杠命令」和「子 Agent」：写一份，按各 Agent 自己的格式同步到 Claude Code、Codex、Gemini CLI、OpenCode、Pi、StepCode、Qwen Code 和 Cursor。
- 📥 可以从各 Agent 已有的命令和子 Agent 导入到 Library，同名同内容只列一次。
- 🛡️ AgentRecall 只写入和删除自己写过的文件；Agent 里已有同名文件或文件被手改过时保持原样，覆盖前会先备份；卸载时也只移除这些文件。
