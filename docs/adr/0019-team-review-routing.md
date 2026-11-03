# ADR 0019：团队资源审核规则与 PR 分流

状态：部分被 [ADR 0020](0020-atomic-team-review.md) 替代。资源级规则和 GitHub 比较页仍适用；同批资源分流及清单路径保护按新决策执行。

## 背景

团队资源由有写权限的成员直接发布到默认分支。MCP、Env 与执行脚本的 Skill 会在每位成员本机生效，团队希望这些资源像代码一样先经指定成员审核。GitHub 的 CODEOWNERS 只按路径匹配，而 MCP 与 Env 都保存在同一个 `agentrecall.json` 中，无法按资源区分。

## 决策

在仓库根目录保存 `OWNERS.json`，按资源类型或 `类型:标识` 指定 GitHub 审核人，作为审核路由的唯一来源。推送前从远端默认分支读取规则；命中规则的资源提交到由内容摘要命名的新分支，返回 GitHub 比较页地址供成员创建 Pull Request，默认分支、团队缓存和本地工作副本保持不变；未命中的资源仍直接发布。规则发布时生成 `.github/CODEOWNERS` 作为分支保护的辅助，清单内资源映射到 `agentrecall.json`，不覆盖手写文件。

## 影响

审核中的修改在合并前不会分发给成员，本地工作副本保留到 Pull 获得合并结果。审核分支不覆盖他人分支，同一内容不会重复提交。应用不持有 PR 权限，也不调用 GitHub PR API；PR 的创建、评论和合并都在 GitHub 中完成。规则不替代仓库权限，强制执行依赖 GitHub 分支保护。

## 考虑的替代方案

- 直接调用 GitHub API 创建 PR：需要额外令牌权限并处理 Fork、草稿与失败恢复，比较页地址已满足需求。
- 只生成 CODEOWNERS：无法区分清单内的 MCP 与 Env，也无法在推送前告诉成员需要谁审核。
- 全部修改都走 PR：会让文档等低风险资源失去直接发布能力，因此只分流受保护的资源。

关联：[团队资产规格](../spec/team-assets.md#审核规则与-pr-分流)、`packages/workspace-core/src/review-rules.ts`、`packages/workspace-core/src/git-assets.ts`、`apps/main-2.0/src/main/services/team-push-service.ts`。
