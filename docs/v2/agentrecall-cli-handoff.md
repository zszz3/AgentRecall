# AgentRecall CLI 与团队功能：开发交接

核对日期：2026-09-27。本文描述当前开发分支，尚未合入 main 或发布。

## 工作位置

- 工作区：`~/.codex/worktrees/cli-foundation/agentrecall`
- 分支：`codex/cli-foundation`
- 统一草稿 MR：[PR #584](https://github.com/zszz3/AgentRecall/pull/584)。用户明确要求先 review，不合入 main。
- 多人 Chat 删除已并入同一分支，旧 [PR #585](https://github.com/zszz3/AgentRecall/pull/585) 已关闭；历史 Session、聊天数据保留。
- 原 `~/learnspace/agentrecall` 是独立索引任务，不要混入此分支或清理其本地文件。

开始前检查当前分支和未提交改动。本文不是当前 CI 结果，测试、推送、review、合入和发布应分别核实。

## 当前产品模型

**团队资产库 + 工作目录接入**。设置管理团队连接与总开关；团队空间直接提供共享会话、Skills、文档、工作目录四个入口。用户不再被要求创建或选择逻辑项目。

工作目录不必是 Git 仓库。一个团队可接入多个目录，各目录分别启停并选择 Codex/Claude Code；首版同一本地目录只接入一个团队。接入不自动安装、同步或上传，应用资产需先预览。停用或断开保留本地文件和分享。

本地内容与团队内容分别展示。选择接入目录后可只读查看本地 Markdown 和 Skill 入口；空团队清单不会被当成本地为空。本地文件上传/贡献 PR 的界面尚未实现，发布仍通过团队 Git 资产仓库维护。

逻辑项目、角色分发、自动同步和用户全局安装均不在此版。不要恢复已撤下的团队→新建项目导航，也不要把 TeamAI 的本地安装范围与逻辑项目混为一谈。

## 当前实现

| 范围 | 实现与入口 |
| --- | --- |
| 配置与目录连接 | `packages/workspace-core/src/config.ts`、`workspace.ts`；版本 3 增加 directories，读兼容版本 1/2 |
| 无项目的团队资产 | `TeamAssetService` 接受 teamId 选择，可直接同步、列出、预览；安装需固定 connectionId/path/client |
| Skills | 单 Skill 安装、diff/update、备份/回滚/卸载；工作配置批量安装、整组差异/更新/卸载与共享引用保护 |
| 文档 | 资产清单版本 3，AGENTS.md、CLAUDE.md 和 docs Markdown；预览比较，只创建缺失文件，冲突拒绝覆盖 |
| 完整会话 | `team-session-sharing.ts`、`team-session-github.ts`；右键选团队、完整预览、系统确认、私有 GitHub Release 附件读写/下载/撤回 |
| 本地资产 | `team-local-assets.ts`；主进程只读、有范围/大小上限、跳过链接；独立 IPC 及本地预览组件 |
| 桌面 | `team-workspace-page.tsx` 管理团队和目录，三个资源面板及会话分享弹窗；没有全局 Local/Team 切换 |
| CLI | team/skill/work-config 可用 --team，安装用 --connection；directory add/list/enable/disable/remove；旧 project 命令保留兼容 |

### 兼容边界

旧仓库项目只读投影为工作目录连接。首次修改连接时升级配置为版本 3，保留原 projects、安装文件与目录内归属记录。无目录的旧逻辑项目不会变成连接。团队会话列表汇总同一私有仓库的旧项目分享，保留原包，不做远端搬迁或删除。

会话包继续兼容版本 1/2，新的分享使用团队范围，来源工作目录保存在原始元数据中。跨团队仍按仓库权限和包内 repository 校验。不要将项目过滤当作 GitHub 仓库内的独立访问控制。

详细大小限制、配置格式和使用方式只有一份权威文档：[团队空间](team-workspace.md)、[团队资产](team-assets.md)、[CLI](cli.md)。

## 验证与未完成事项

验证全部使用临时 HOME/npm 前缀、合成 Git 仓库或模拟 GitHub API，不读写真实个人 Session。界面检查使用真实 React 组件与合成数据，不能称为真实私有仓库两用户验收。

当前核验应包括：CLI tests/typecheck、V2 团队 IPC/会话/本地扫描/界面测试、V2 类型检查与构建、发布说明检查。原 Chat 删除有历史 Session 与保留功能回归，合并基线曾通过 141 项检查；后续改动应核对对应最新结果。

仍未完成：真实私有仓库两成员联调、个人贡献团队的 PR 流程、会话搜索筛选/导入恢复/断点续传、文档编辑/合并/回滚、跨配置协调更新、正式 CLI 分发、自动同步与召回。用户当前要求先 review，不推进 main 或发布。
