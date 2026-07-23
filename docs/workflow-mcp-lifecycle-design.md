# Workflow MCP 生命周期与节点工具可观测性设计

## 背景

AgentRecall 的 Workflow MCP 已支持草稿创建、读取、更新、校验和上下文追加，但尚不能覆盖确认、执行、等待人工动作、停止和结果读取的完整生命周期。节点执行侧虽然定义了 `workflow_node_complete`，不同 Runtime 和执行模式对 Workflow MCP 上下文的注入并不一致；节点会话弹窗还会把工具调用统一隐藏在默认收起的运行时详情中。

本次改造将这三个问题作为同一条受控链路处理：MCP 客户端获得什么权限、运行时能够看到哪些工具、工具调用如何驱动 Workflow 状态，以及用户如何在会话中审计这些调用。

## 目标

- 可信的 AgentRecall 托管节点能够通过 Workflow MCP 提交结构化节点结果。
- MCP 客户端能够完成“校验—确认—运行—查询—处理人工动作—停止—读取产物”的闭环。
- 外部 MCP 客户端默认只读，状态变更只允许 AgentRecall 托管的本地 MCP 会话执行。
- 所有状态变更使用 revision、runId、nodeId 等身份字段防止并发误操作。
- 工具调用和工具结果在节点会话主时间线中可见，同时保留低层运行时详情。
- MCP 断开不影响已经由主进程接管的 Run，也不会绕过 Script 审批。

## 非目标

- V1 不开放远程客户端写权限，也不设计远程授权管理界面。
- 不新增第二套 Workflow 执行器、状态存储或审批系统。
- 不允许 MCP 直接写数据库或直接改变 Renderer 状态。
- 不在本次实现 Run 对比、失败节点重跑或完整成本统计。

## 总体架构

```text
外部 MCP 客户端 ──只读令牌──┐
                           ├─> 本地 MCP Bridge ─> AgentHub ─> WorkflowRuntime
托管节点 MCP ──写入令牌────┘          │
                                     ├─> 持久化 Run / Conversation / Output
                                     └─> Renderer 订阅同一 AppSnapshot
```

Bridge 是唯一状态变更入口。MCP Server 只负责声明工具、校验 JSON-RPC 形状并转发请求；AgentHub 和现有 WorkflowRuntime 继续拥有状态机、审批、并发与持久化语义。

## 权限模型

### 双令牌

Bridge 启动时生成两个独立随机令牌：

- `readToken`：写入 discovery 文件，供独立启动的外部 MCP 客户端读取，只允许查询路由。
- `managedToken`：只保存在主进程内存中，由 AgentRecall 在启动托管节点 MCP 时通过环境变量注入，允许受控写路由。

discovery 文件不得包含 `managedToken`。请求是否可写由 Bridge 根据实际令牌判定，不信任客户端声明的 header、环境变量或工具参数。

### 路由权限

只读路由包括 Workflow、Run 和输出查询。创建草稿、更新、确认、运行、停止、处理人工动作、提交脚本输入、追加上下文以及节点完成均属于写路由。

MCP Server 根据当前访问模式只暴露允许调用的工具；Bridge 仍进行最终授权，防止客户端绕过工具列表直接访问 HTTP 路由。

## 统一 Workflow MCP 绑定

主进程内部使用一个绑定对象表达 MCP 上下文：

```ts
interface WorkflowMcpBinding {
  discoveryPath: string;
  managedToken?: string;
  workflowId?: string;
  runId?: string;
  nodeId?: string;
}
```

Codex、Claude 和 ACP 适配层只能把该绑定转换为各自的启动参数，不再手工挑选环境变量。托管节点绑定包含 workflowId、runId、nodeId 和 managedToken；规划会话包含 workflowId 和 managedToken；外部 MCP 默认仅从 discovery 文件取得 readToken。

`workflow_node_complete` 仅在 runId 与 nodeId 同时存在时注册。所有支持 Workflow 节点执行的 Runtime，无论 one-shot 还是 interactive，都必须经过同一绑定生成路径。不支持 MCP 的 API Runtime 明确使用结构化文本兜底。

## 生命周期工具

### 查询工具

- `workflow_run_list`：按 workflowId、状态和时间筛选 Run 摘要。
- `workflow_run_get`：读取指定 Run、节点状态、待处理人工动作和输出摘要。
- `workflow_outputs_list`：读取产物的安全元数据和受限预览，不返回本地绝对路径。

### 状态变更工具

- `workflow_confirm`：要求 workflowId 与 expectedRevision。
- `workflow_run`：要求 workflowId，可携带 expectedRevision 和运行上下文，返回 runId。
- `workflow_stop`：要求 workflowId 与 runId。
- `workflow_intervention_resolve`：要求 workflowId、runId、nodeId、action，可携带 reason。
- `workflow_script_input_submit`：要求 workflowId、runId、nodeId 和 values。

工具直接调用 AgentHub 已有方法，不复制状态机。Script 审批仍由现有 intervention 流程处理。

## 稳定响应与错误

成功响应统一为：

```json
{ "ok": true, "data": {} }
```

失败响应统一为：

```json
{ "ok": false, "error": { "code": "WORKFLOW_REVISION_CONFLICT", "message": "Workflow revision changed." } }
```

V1 至少定义：`UNAUTHORIZED`、`READ_ONLY_CLIENT`、`INVALID_ARGUMENT`、`WORKFLOW_NOT_FOUND`、`RUN_NOT_FOUND`、`NODE_NOT_FOUND`、`WORKFLOW_REVISION_CONFLICT`、`RUN_IDENTITY_MISMATCH`、`INVALID_STATE`、`INTERVENTION_ALREADY_RESOLVED` 和 `INTERNAL_ERROR`。

现有自由文本错误在 Bridge 边界归一化，MCP 客户端不依赖英文句子解析状态。

## 结构化节点完成

`workflow_node_complete` 是节点结构化结果的权威提交通道：

1. Bridge 校验托管权限、workflowId、runId、nodeId 和输出结构。
2. 当前实现阶段先通过受控响应把已校验 output 返回运行时，并完整保留 tool call/result 事件。
3. Conversation Manager 优先消费该工具调用生成 completion proposal；普通 JSON 只在工具确实不可用时兜底。
4. 同一 node attempt 的重复提交必须幂等或稳定拒绝，不能推进两次节点状态。

后续若将完成提交改为独立持久化领域事件，应保持同一工具合同，不改变 Agent 侧调用方式。

## Run 与输出投影

生命周期查询只从 `hub.snapshot()` 和现有输出服务生成安全投影：

- Run 返回身份、状态、触发来源、revision、时间和节点摘要。
- 待处理动作根据节点等待状态、intervention 和 script input request 生成。
- 输出只返回名称、类型、大小、摘要或安全预览；不暴露授权头、环境变量、令牌和设备绝对路径。

查询不会创建 Run、恢复节点或触发计算。

## 会话时间线

节点会话弹窗按消息时间顺序显示 user、assistant、tool_call 和 tool_result。工具卡片默认展示名称、状态和时间，参数与完整结果可以折叠。

`workflow_node_complete` 使用“已提交结构化节点结果”的专用标签。system instruction 和无法映射为用户行为的底层 Runtime 事件继续放在 `Runtime details`。

one-shot Task 和 interactive Conversation 最终应呈现一致的工具事件语义，不因底层消息容器不同而隐藏调用。

## 并发、生命周期与恢复

- `workflow_confirm` 和 `workflow_run` 校验 expectedRevision。
- 所有 Run 写操作精确匹配 workflowId + runId；节点写操作再匹配 nodeId。
- 已解决 intervention 的重复请求返回稳定冲突，不重复执行。
- Bridge 只发起命令，不持有 Run 生命周期；MCP stdio 断开后 Run 继续由主进程执行。
- 桌面端和 MCP 共用 AgentHub 方法，因此不会形成第二套 waiter 或双重执行路径。

## 测试策略

- 绑定单元测试：Codex、Claude、ACP 均完整携带 workflow/run/node/managed token。
- Runtime 矩阵测试：one-shot 与 interactive 均能看到 `workflow_node_complete`。
- Bridge 授权测试：readToken 可查询但不能写，managedToken 可写，伪造访问模式无效。
- 生命周期路由测试：成功闭环以及 revision 冲突、错误 runId、重复 intervention。
- MCP Server 测试：不同访问模式暴露正确工具集合和稳定错误结构。
- Conversation 测试：完成工具优先于普通文本，调用和结果均被持久化。
- Renderer 测试：工具事件位于主时间线，system instruction 仍在运行时详情。

## 发布范围

用户可见结果包括：可信本地 Agent 可以通过 MCP 控制 Workflow 完整生命周期，节点结构化结果在支持的 Runtime 中稳定提交，节点会话可直接查看工具调用和结果。
