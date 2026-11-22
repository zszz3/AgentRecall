# DSH 技能使用说明

这套资源来自公开的 DeepSeek Harness 仓库，基于 `477b4f420553e8a52c2fbccc464d7561b239c443`，遵循 MIT 许可。每个 Skill 都保留原始文件、所需的内部引用或模板，以及来源和许可说明。完整来源记录见资产仓库的 `sources/dsh-skills.json`。

## 技能目录

| Skill | 用途 |
| --- | --- |
| `agent-experience` | 工具定义、上下文加载与 Agent 工作流 |
| `dsh-archive-agent-notes` | Agent Notes 分类、维护与归档（配套依赖） |
| `dsh-ci-test-reliability` | 测试隔离、异步清理与 CI 稳定性 |
| `dsh-client-ui-ux` | 客户端交互、反馈、布局与视觉规范 |
| `dsh-code-review` | 代码评审与工程约束核对 |
| `dsh-doc` | 文档结构、模板、双语配对与检查 |
| `dsh-find-simplifications` | 基于现有使用方的代码简化 |
| `dsh-pre-push-checks` | 按改动范围选择提交前检查 |
| `dsh-prose-standard` | 技术文档、注释和界面文案规范 |
| `dsh-speed-up-perf` | 性能剖析、合成基准与行为验证 |
| `dsh-trim-cot-leakage` | 清理不适合留在文档里的推演与过程叙述 |

## 如何使用

在 AgentRecall 团队空间查看资源，选择需要启用的工作目录与客户端，点击「同步团队」。Codex 的 Skill 放在 `.agents/skills/`，Claude Code 放在 `.claude/skills/`。

`agent-experience` 适用于工具与 Agent 体验设计。`dsh-*` 保留 DSH 原有工程约束，适用于 DeepSeek Harness 的开发目录；在其他项目中可参考思路，但应先核对当前仓库的规则、命令和能力。不会因为导入 Skill 就自动获得 DSH 的构建脚本、测试服务或文档工具。

Skill 自身的 `references/`、`templates/` 已包含；指向 DSH 根目录、`packages/`、`docs/` 或 `.agents/notes/` 的路径依赖对应工作副本。阅读资产仓库里的副本时，可通过每个 Skill 的 UPSTREAM.md 打开固定版本的上游目录。

同步不会执行 Skill 中的脚本、上传会话或替用户完成外部操作；实际执行仍按任务授权及当前仓库规则进行。已有同名个人 Skill 或本地修改会保留并报告冲突。

[上游源码](https://github.com/deepseek-ai/deepseek-harness/tree/477b4f420553e8a52c2fbccc464d7561b239c443) · [上游许可](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/LICENSE)
