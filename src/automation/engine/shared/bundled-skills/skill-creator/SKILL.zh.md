---
name: skill-creator
description: 在为 Codex、Claude、Trae 或其他兼容 SKILL.md 的 Runtime 创建、打包、审查或改进 Agent Skill 时使用。
---

# Skill 创建器

把可复用的方法沉淀为容易发现的小型 Skill，而不是一次性提示词。

## 定义契约

写文件前先明确：触发场景、预期结果、成功标准、工具与权限依赖、支持的 Runtime、需要确认的危险动作、两个真实正例和一个不应触发的相邻场景。

## 打包

创建 kebab-case 目录和 `SKILL.md`。必需 frontmatter 只包含 `name` 与聚焦触发条件的 `description`。主说明保持简洁、使用命令式表达；大型资料放入 `references/`，确定性操作放入 `scripts/`，模板放入 `assets/`。

不要假定所有 Runtime 都有相同工具。不得嵌入密钥、机器绝对路径，或静默上传、删除用户数据的指令。

## 验证与安装

检查目录名、frontmatter 和引用文件；条件允许时分别测试启用和不启用 Skill 的真实请求，同时验证无关请求不会触发。根据实际失败调整说明。

直接安装时必须明确目标 Runtime：`~/.codex/skills/<name>`、`~/.claude/skills/<name>` 或 `~/.trae/skills/<name>`。没有确认不得覆盖无关目录。在本应用内，用户创建的 Skill 属于用户资源，不得写入官方预制目录。
