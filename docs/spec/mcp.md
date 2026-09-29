# MCP Gateway 与工具源

范围：V2 MCP Gateway、工具源注册及外部客户端连接。V1 会话 MCP 是独立产品能力，不因此获得 V2 Gateway 的工具目录与控制语义。使用步骤见 [V2 指南](../v2/guide.md)。

## 两层接口

Gateway 的直接工具是 list_skills、get_skill、search_sessions、get_session；其余工具通过 search_tools、get_tool、call_tool 按需发现和调用。

| 接口 | 输入/输出语义 | 不能推断的能力 |
| --- | --- | --- |
| search_tools | 可选 sourceId、cursor、limit；返回精简工具项和 nextCursor | 名字虽然叫 search，目前不做语义搜索 |
| get_tool | toolRef；返回完整说明和 inputSchema | Schema 可读不代表远端服务健康 |
| call_tool | toolRef、arguments；返回底层执行结果 | 目录中存在不代表调用一定成功 |
| 四个直接工具 | 固定高频会话/Skill 操作 | 不绕过来源和单工具启用开关 |

search_tools 默认页长 20，上限 50；cursor 是非负安全整数的字符串。toolRef 由编码后的 sourceId 和工具名组成，不能把列表位置当成稳定身份。精确实现见 [MCP 服务](../../apps/main-2.0/src/main/services/mcp-automation-module.ts)。

## 注册、发现与缓存

保存新工具源或改变连接字段时尝试发现工具目录。发现成功保存新目录；失败保留上次成功目录并记录错误。仅开关变化不应被当成修改了连接配置。

手动测试内置工具源使用内置启动配置，不能使用 renderer 提交的替代命令绕过约束。内置工具源不能删除，可停用；自定义源删除后需要清理相关绑定并持久化。

目录缓存、最近测试状态和实时调用状态分别表达不同事实。页面必须允许用户看到“目录仍在，但本次刷新失败”。

## 调用权限

每次 get/call 都从当前启用目录解析 toolRef；之前发现过但后来停用、删除或改名的工具不能继续调用。直接工具也要检查对应来源和工具开关。

通用索引排除四个直接工具，避免重复暴露。依赖当前 Workflow Run 或 Review Revision 的临时能力只在所属上下文开放，不得为方便调用放进全局 Gateway。

## 连接客户端

V2 为 Codex 和 Claude Code 管理名为 agent-recall 的 Gateway 配置。客户端连接与工具源开关是两个维度：连接成功只表示客户端配置写入，工具是否开放仍由服务器端当前状态决定。

连接动作同时授权 Gateway 的客户端信任配置，断开时移除对应配置与信任。应用启动修复已启用且检测到的客户端连接；手动断开不能在下次启动被无条件恢复。客户端可能需要重启才能读取新配置，AgentRecall 需要运行才能提供 Gateway。

## 传输和环境变量

自定义工具源支持 STDIO 或 HTTP。STDIO 子进程与网络连接由主进程 MCP 客户端拥有，不由 React 创建。

[mcp-client](../../apps/main-2.0/src/automation/engine/main/mcp-client.ts)默认把配置中的 env 值作为宿主环境变量名解析；显式 literalEnv 是另一条路径。未解析到变量当前会得到空字符串，不能在文档里保证“所有缺失变量都预检拒绝”。配置中引用变量不代表凭据实际存在。

团队 Pull 写入编码客户端的 MCP 配置，与此处 AgentRecall Gateway 注册是不同操作，见 [团队资产](team-assets.md)。

## 验收场景

| 场景 | 期望结果 |
| --- | --- |
| 来源或单工具停用后使用旧 toolRef | 调用被拒绝 |
| 直接 Session 工具被停用 | 不能绕过开关调用 |
| 新源发现失败 | 保留配置和错误，不声称已连接 |
| 已有源刷新失败 | 上次工具目录仍可查看，错误可见 |
| 手动测试内置源携带替代命令 | 使用内置实际配置 |
| 分页 cursor 非法 | 拒绝输入，不静默跳到未知页 |
| 修改客户端连接 | 结果说明配置状态，不假称客户端已重载 |

## 验证入口

[服务测试](../../apps/main-2.0/src/main/services/mcp-automation-module.test.ts)覆盖目录分页、旧引用、开关和发现失败；[客户端测试](../../apps/main-2.0/src/automation/engine/main/mcp-client.test.ts)覆盖环境变量解析；[Gateway 入口](../../apps/main-2.0/src/mcp/gateway-entry.ts)负责外部工具暴露。

新增工具仍需实现端到端权限和执行边界，不能仅增加 Schema 或依赖调用方提示词限制。
