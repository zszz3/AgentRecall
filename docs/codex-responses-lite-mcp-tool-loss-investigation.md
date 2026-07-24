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
