# Codex Responses Lite 模式丢失 Workflow MCP 工具排查记录

## 问题现象

Workflow Agent 在规划会话中能够正常对话，但需要写入草稿时反复回答：

> 当前会话未提供 workflow_create（或 mcp__agent_recall__workflow_create）工具。

模型没有产生 `workflow_create` 调用，前端时间线中也没有对应的工具调用或失败结果。重启应用和重建 Workflow 会话后问题仍然存在。

## 排查范围

排查按工具生命周期从外到内进行：

1. AgentRecall 是否为 Workflow 规划会话生成了正确的 MCP 启动参数。
2. Workflow MCP 子进程是否启动并完成 `initialize` 与 `tools/list`。
3. Codex App Server 是否能查询到 `workflow_create`。
4. Codex 当前线程是否将 MCP 工具纳入工具规划。
5. Codex 发往模型渠道的 Responses 请求是否携带工具。
6. AgentRecall Responses 到 Chat Completions 的兼容转换是否保留工具。

## 关键证据

### MCP 配置和启动正常

运行中的 Codex 命令行包含当前 Workflow MCP 的 command、args、环境变量、Workflow ID、scope 和托管令牌。Workflow MCP 子进程存在，`mcpServerStatus/list` 能返回 `workflow_create`。

这排除了“本机 MCP 未放行”“MCP 服务未启动”和“工具未注册”。

### Codex 已构建模型可见工具

使用当前安装的 Codex 0.145、真实 `CodexRpcClient`、隔离 MCP Server 和隔离模型上游进行进程级复现。Codex trace 显示：

```text
tool_spec_count=9
```

说明 MCP 工具已经进入 Codex 线程的工具规划，不是线程创建过早或 MCP schema 转换失败。

### Responses Lite 改变了工具位置

隔离上游捕获到 Codex 发出的真实请求：

```json
{
  "model": "gpt-5.6-sol",
  "tools": [],
  "input": [
    {
      "type": "additional_tools",
      "role": "developer",
      "tools": [
        { "type": "custom" },
        { "type": "function" },
        { "type": "function" },
        { "type": "namespace" }
      ]
    }
  ]
}
```

Responses Lite 模式不会把这些工具放在顶层 `tools`，而是将它们作为 `additional_tools` 控制项放入 `input`。其中的 namespace 包含 `mcp__agent_recall.workflow_create`。

### AgentRecall 转换器只读取顶层工具

兼容路由原先只从 `body.tools` 构建 Chat Completions 工具列表，并只额外识别 `tool_search_output.tools`。它没有处理 `input[].type === "additional_tools"`，因此转换后的 Chat 请求没有任何工具。

模型实际收到的是普通对话请求，只能根据可见上下文回答“未提供 workflow_create”。由于调用从未发生，前端没有工具事件也是符合当时真实状态的下游表现。

## 根因

根因是 Codex 0.145 的 Responses Lite 请求合同与 AgentRecall Chat 兼容路由之间存在版本兼容缺口：

```text
Workflow MCP tools/list 成功
  -> Codex 构建工具定义
  -> Responses Lite 将定义写入 input.additional_tools
  -> AgentRecall Router 仅读取 body.tools
  -> Chat Completions 请求 tools 为空
  -> 模型误判工具未暴露
```

此前的 MCP readiness、延迟工具发现和 eager exposure 修复分别解决了启动时序、`tool_search` 和首轮暴露问题，但都没有覆盖 `additional_tools` 这一新的承载位置。

## 修改内容

### 协议兼容

Chat 兼容路由现在从三个来源合并工具定义：

- Responses 顶层 `body.tools`；
- Responses Lite 的 `input[].additional_tools.tools`；
- 延迟发现结果 `tool_search_output.tools`。

三种来源继续进入同一套 function、custom、namespace 和 tool_search 转换逻辑，并由现有工具名映射去重。

`additional_tools` 是协议控制项，不会被转换成 system、user 或 assistant 消息。

### 回归测试

新增真实 Lite 形状的转换测试：

- 顶层 `tools` 为空；
- `input` 包含 `additional_tools`；
- namespace 内包含 `workflow_create`；
- 转换后的 Chat 请求包含扁平化工具名 `mcp__agent_recall__workflow_create`；
- Chat 工具调用能够还原为带 namespace 的 Responses `function_call`；
- `additional_tools` 不会污染模型消息列表。

原有顶层 eager tools 和 `tool_search_output` 测试继续保留，用于保证三种工具来源兼容。

## 影响范围

该问题影响经过 AgentRecall Responses 到 Chat Completions 兼容路由的 Codex 第三方模型渠道。

- Codex 原生 Responses 渠道不经过该转换，不受本缺陷影响。
- Claude Code 和 ACP Runtime 使用各自的 MCP 注入与协议链路，不经过该 Router，不属于本次根因。
- Workflow MCP 权限、Bridge 鉴权和 Workflow 状态机没有改变。

## 后续诊断原则

遇到“模型声称工具不存在”时，需要分别验证：

1. MCP 是否在 `tools/list` 中声明工具；
2. Runtime 是否将工具纳入当前线程规划；
3. 最终模型请求是否真正携带工具；
4. 模型是否产生调用；
5. 调用是否被审批、执行并形成结果。

仅检查 MCP 配置或状态接口不足以证明模型实际获得了工具。最终请求体和工具调用事件才是暴露链路的权威证据。

## 后续问题：工具已暴露但被立即拒绝

### 现象与定位

完成 Responses Lite 工具承载兼容后，Codex 已能发现并发起 `workflow_create`，但调用会在进入 `in_progress` 后立即失败：

```text
user rejected MCP tool call
```

对应 rollout 中，从工具调用记录到失败结果不足 100ms，期间没有用户审批事件，也没有 MCP 服务端调用结果。这证明失败发生在 Codex 的工具审批层，而不是 Workflow Bridge、MCP Handler 或前端交互层。

### 根因

Codex 0.145 支持 MCP Server 和单个 MCP Tool 的原生审批模式。未显式配置时，默认 `auto` 会根据工具语义决定是否提示；`workflow_create` 的描述包含“写入草稿”，因此被判定为需要审批。

Workflow Agent 使用非终端 App Server 会话。该会话不能像 Codex CLI 终端一样直接承接 MCP 原生审批提示，于是提示没有到达 AgentRecall 的 Runtime Approval Broker，Codex 随即把调用作为用户拒绝处理。旧的 `item/mcpToolCall/requestApproval` 兼容处理无法覆盖 Codex 0.145 的这一原生 MCP 审批路径。

### 修改

Codex Workflow MCP 启动配置现在由共享 Workflow MCP 权限策略同时生成三层约束：

- `enabled_tools` 仅包含当前 planning 或 node execution scope 可见的工具；
- Server 默认审批模式保持 `prompt`，未知或生命周期变更操作不会静默执行；
- 仅将共享策略判定为 `allow` 的工具逐项配置为 `approval_mode="approve"`。

因此 `workflow_create`、`workflow_get`、`workflow_node_complete` 等当前 scope 内的安全操作可以正常执行；`workflow_confirm`、`workflow_run`、`workflow_stop` 等需要批准的生命周期操作仍不会被自动放行。旧版 Codex 的 App Server 审批响应逻辑继续保留，作为协议兼容路径。

### 诊断结论更新

工具生命周期需要区分六个阶段：

```text
配置 -> 启动 -> 暴露 -> 模型选择 -> 审批 -> MCP 执行
```

“工具不存在”对应暴露或模型请求问题；`user rejected MCP tool call` 且没有用户操作，对应审批配置问题；只有出现 MCP 服务端结果后，才进入 Bridge、鉴权和业务 Handler 的排查范围。

## 后续完善：可交互审批与长结构化结果

### Workflow 草稿审批为什么仍需补前端链路

自动允许仅适用于共享策略明确判定安全的当前 scope 工具。其他需要确认的 MCP 调用仍会产生 Runtime Approval Broker 请求。此前普通聊天和节点交互会话能够显示这类事件，但 Workflow 草稿会话只转发 `tool_call` 与 `tool_result`，导致真实审批请求没有进入草稿时间线。

现已统一转发 `approval_request` 与 `approval_response`，并复用现有审批卡片和 Broker resolve 接口。审批 owner 固定为 `workflow-draft:<workflowId>`；停止回复、重置、会话重绑、超时和删除时都会取消该 owner 的请求。应用重启后没有对应内存 waiter 的历史请求恢复为过期状态，避免点击一个已经无法完成的审批。

### `Bad control character` 并非工具生成了非法 JSON

失败 Run 的持久化事件证明 `workflow_node_complete` 已返回 `ok: true`，完整结构化结果也存在。真正的问题发生在 Codex 事件归一化：工具参数为了时间线展示被截断为 600 字符并追加 `...`，而节点完成提取逻辑优先读取该 `tool_call` 内容，最终把展示摘要当成权威 JSON 解析。

修复后，`workflow_node_complete` 参数作为协议数据完整保留；其他工具仍使用摘要。界面是否折叠属于渲染决策，不能再修改状态机消费的数据。回归测试覆盖超过摘要上限、包含换行和 Markdown 的完成包，确认归一化后仍可直接 `JSON.parse`。

### 后续架构重构：历史事件退出权威数据链路

进一步审计发现，即使不再截断，执行器从 `task.messages[].events` 或 Conversation 消息中反查最后一次完成工具调用，仍然把展示与审计数据当成领域结果。这会继续受到事件丢失、恢复顺序、重复调用和 Renderer 摘要策略影响。

现已引入独立的节点 completion submission ledger：

- 节点执行开始前创建 workflow/run/node/execution/attempt 绑定；
- MCP Server 从宿主环境注入 executionId，模型不能覆盖；
- Bridge 原子持久化完整 output，并返回 submissionId、digest 和状态；
- 重复 output 按规范化 digest 幂等，不同的新提交 supersede 旧候选；
- one-shot 从 ledger 消费，interactive 以 submission 生成待用户确认 proposal；
- 只有通过 Review、Hook 或用户确认的 output 才进入 Run checkpoint 的 `workerOutputs`。

会话工具事件继续保留完整审计记录，但删除了所有从 `workflow_node_complete` 历史事件提取权威结果的执行路径。回归测试会故意提供截断的历史工具 JSON，同时从 ledger 提供合法 submission，确认 Run 使用持久化结果完成。
