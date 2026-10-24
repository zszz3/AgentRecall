# ADR 0016：团队 Workflow 模板引用角色，个人副本记录来源并确认脚本

状态：已采用。

## 背景

团队希望共享调好的 Workflow，但个人 Workflow 的 Agent 节点引用本机 Agent ID，这些 ID 和背后的渠道只在本机存在；工作目录也是个人路径。脚本节点会在成员机器上直接执行，由他人编写的脚本不应在成员未阅读时运行。

## 决策

版本 6 清单增加 `workflowTemplates`，每个模板保存为 `workflows/<id>.json`。Agent 与评审节点用 `role` 引用同一快照中的团队角色，模板内禁止 `agentId`；引用不存在的角色或含疑似明文密钥时拒绝。发布时，个人 Workflow 中的每个 Agent 必须带本团队的角色标签才能转换为角色引用，工作目录与渠道不进入模板。

使用模板时，用本机从对应角色启用的 Agent 替换角色，生成新的个人 Workflow，并在定义上记录 `origin`（团队、仓库、模板、摘要、复制时间）。角色未启用时不创建副本。副本与模板此后独立，团队更新模板不自动改写个人副本。

含脚本节点的副本首次运行前需要成员确认。确认时间 `scriptsConfirmedAt` 只由主进程的专用操作写入；保存定义保留已存的来源，新建定义去掉请求中的确认时间，启动运行在未确认时拒绝。

## 影响与替代方案

成员必须先启用模板用到的角色。模板更新后需要重新“使用模板”获得新副本。直接共享个人 Workflow 定义会泄露 Agent ID 与本机路径，且在其他机器上无法运行；Pull 时自动生成 Workflow 会在成员未确认时引入可执行脚本，因此都不采用。确认记录在副本上而不是团队侧，因为是否信任脚本是每位成员在本机的决定。

## 关联

- [团队资产规格](../spec/team-assets.md#workflow-模板)
- [Workflow 规格](../spec/workflow.md)
- [模板格式](../../packages/workspace-core/src/workflow-templates.ts)
- [脚本确认](../../apps/main-2.0/src/main/services/workflow-core-service.ts)
