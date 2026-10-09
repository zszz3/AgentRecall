# 让 Agent 检索会话与团队资源

要找“以前怎么解决”，搜索会话；要找“现在应该遵守什么”，搜索文档、Skill 或共享指令。两条检索入口分开，不混合排名。CLI 命令表见[CLI 指南](cli.md#分开搜索会话与资源)，接口契约见[检索规格](../spec/knowledge-search.md)。

## 准备条件

- 启动 AgentRecall V2，保持运行。CLI 配置管理可独立运行，检索命令需要 V2 提供本地服务。
- 本机会话先完成来源索引；团队会话先 Pull 并完成本地整理。
- 在 MCP 页面启用所需来源和工具。CLI 检索也遵守这些开关。
- 搜索团队时开启团队功能，明确选择团队；本机范围不会自动搜索所有团队。

使用 MCP 时，按[Gateway 连接说明](guide.md#7-通过-mcp-gateway-使用工具)接入客户端。使用 CLI 时先按[CLI 包说明](../../apps/cli/README.md)构建安装；当前仍是源码预览包。

## 找到处理过程，再读命中的轮次

以下命令中的团队 ID、会话键和轮次 ID 均需替换为本机返回的值。

```sh
agentrecall team list
agentrecall session search "端口冲突" --scope team --team engineering
agentrecall session get '<返回的 sessionKey>'
agentrecall session get '<返回的 sessionKey>' --record 0 --turn '<命中的 turnId>'
```

搜索命中附带轮次位置时，使用返回的 record 和 turnId；不要总是假设命中主会话的第一轮。没有正文命中位置时先读轮次目录，再选择需要的正文。会话键是返回的标识，不是可自行拼接的文件路径。

本机历史使用 `agentrecall session search "端口冲突"`，读取按消息分页；团队历史按分享、子会话和轮次组织。具体分页参数见 CLI 指南。需要查日志时，团队搜索可加 `--include-tools`；未开启时不要将“没搜到日志”解释为内容丢失。

## 找到规范，再读原文

```sh
agentrecall resource search "代码审查" --scope team --team engineering --type skill
agentrecall resource search "部署 回滚" --scope team --team engineering --type document
agentrecall resource get '<返回的 id>' --scope team --team engineering --type document
```

搜索返回摘要，读取返回正文；正文有 nextOffset 时继续传入该 offset，直到获得所需范围。读取必须沿用搜索时的团队和资源类型，资源 ID 单独并不足以确定范围。

当前资源搜索是大小写不敏感的关键词包含匹配，空白分隔的词必须全部出现，可以分布在标题、说明和正文中。`部署 回滚` 因此比 `部署` 更严格。没有结果时可减少词数或换成文档实际使用的术语，不把它当成语义搜索。

## 搜索覆盖什么

| 范围 | 会话搜索 | 资源搜索 |
| --- | --- | --- |
| local | 本机已索引会话 | 本机托管 Skill 库 |
| team | 指定团队已整理的完整分享与片段 | 本地团队工作副本中的 Skill、文档、共享指令 |

团队资源包括本机尚未 Push 的修改，所以 A 和 B 在各自电脑上可能搜到不同版本。搜索不会主动 Pull，也不会替用户发布草稿。资源搜索不扫描任意个人目录，不覆盖 MCP 和 Env 配置。

## MCP 中的对应操作

| 意图 | 工具 |
| --- | --- |
| 找会话 | `search_sessions` |
| 读会话或命中轮次 | `get_session` |
| 找规范与 Skill | `search_resources` |
| 读资源正文 | `get_resource` |

这四个工具可直接使用，不必先通过 `search_tools` 查找。目录可见、工具已启用、具体读取成功是不同状态；实际操作仍会验证当前权限和团队配置。

## 检索结果怎么使用

先用标题和摘要选择，再读取原文核实结论、上下文与适用范围。会话说明曾经发生什么，不能自动取代当前规范。引用结果时保留团队、资源或会话标识，必要时注明片段范围；只读过摘要时不要声称已经审阅完整历史。

检索到 Skill 不会自动安装它，读到共享指令不会自动写入客户端配置。团队资源安装由 Pull 分发负责；Agent 是否读取普通文档由当前任务和客户端行为决定。

## 常见问题

| 情况 | 处理 |
| --- | --- |
| 提示先启动 V2 | 启动或重启 V2，再运行命令 |
| 桌面能看，CLI 被拒绝 | 检查对应 MCP 来源和工具开关，以及团队范围 |
| 团队无结果 | 确认团队 ID、Pull 整理状态和实际关键词 |
| 仓库改变或旧引用失效 | 重新搜索，再读取新返回的引用 |
| 完整响应超限 | 缩小读取范围；单个团队 Turn 仍过大时不能靠减小搜索条数解决 |

检索只访问本机服务，但调用它的 Agent 可能把返回正文放入所选模型的上下文；不要把“检索不联网”理解为后续模型调用不会传输这些内容。
