# 个人 Library：一份指令写进所有本机 Agent

<!-- release-target: v2 -->

## 新增功能

- 📚 新增「Library」页：写一份个人指令，按需开启 Claude Code、Codex、Gemini CLI、OpenCode、Pi、StepCode、Qwen Code、DeepSeek Harness、ZCode，指令会写进它们的用户级指令文件，对所有项目生效；文件里原有的内容保持不变，开启前可以先看到写入后的文件。
- 📥 「从 Agent 导入」把各 Agent 指令文件里已有的段落合并进 Library，重复的段落只列一次；可以选择同时从原文件移出，原文件会先备份。
- 🛡️ 文件里 AgentRecall 写入的部分被手动改过时会停下提示，可选择保留文件里的版本或覆盖；已由 magpie 管理的文件不会写入；关闭某个 Agent 或卸载 AgentRecall 时只移除 AgentRecall 写入的部分。
