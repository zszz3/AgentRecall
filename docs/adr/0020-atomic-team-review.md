# ADR 0020：团队 Git 资源整批审核与清单保护

状态：已采用，适用于 V2 团队空间与 workspace-core；替代 [ADR 0019](0019-team-review-routing.md) 中同批资源分别直推和送审的决策。

## 背景

团队 Git 资源共用一份清单，新角色还可能引用同批新增的 Skill、MCP，模板也可能引用新角色。把同一次操作拆成从同一旧版本派生的直推与审核提交，会产生缺少依赖的审核快照和清单合并冲突。只保护资源正文路径也无法覆盖模型或引用等仅修改清单的操作。

## 决策

所选 Git 资源作为一个完整快照发布。只要其中任一有变化的资源命中审核规则，整批送审；所有有变化的资源均未命中时仍整批直推。预览对全部送审条目显示本批审核人，确认说明整批送审。共享会话继续独立上传。

无论提交到默认分支还是审核分支，推送前都读取并校验实际生成的提交树，包括资源间的引用。审核提交校验成功不会更新默认分支缓存。

除审核规则自身外，CODEOWNERS 中每条资源规则同时覆盖共享清单与对应资源文件。清单的审核人取相关规则的并集。已有团队重新保存规则即可刷新生成文件，不覆盖手写 CODEOWNERS。

## 影响

与受保护内容一起选择的普通资源也会等待审核；成员可单独选择无保护资源直接发布。整批提交保留资源依赖，避免同次操作在两个分支中修改同一清单。应用仍不创建或合并 GitHub PR。

GitHub 只按文件匹配，清单保护会扩大到其中的其他资源，无法保证按字段分别由某一指定资源的审核人批准；同一文件的多个所有者中任一人批准即可满足 Code Owners 要求。此限制遵循 [GitHub 官方说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#codeowners-and-branch-protection)。

## 考虑的替代方案

- 保留分流并先直推依赖，再生成审核预览：改变已经确认的远端版本与快照，增加部分发布、重新确认及失败恢复的复杂度。
- 只把有直接引用关系的条目放在一起：独立资源仍共用清单，同次操作仍可能产生清单冲突。
- 仅添加审核分支校验：可以拒绝无效引用，但不能让有效的配套资源顺利一起上传。

关联：[团队资产规格](../spec/team-assets.md#审核规则与-pr-分流)、[Git 资产实现](../../packages/workspace-core/src/git-assets.ts)、[Push 服务](../../apps/main-2.0/src/main/services/team-push-service.ts)、[配置发布测试](../../apps/cli/test/configuration-authoring.test.ts)、[Push 测试](../../apps/main-2.0/src/main/services/team-push-service.test.ts)。
