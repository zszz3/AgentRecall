# Workflow MCP Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐受控 Workflow MCP 生命周期，并保证所有支持 MCP 的节点 Runtime 能提交结构化结果且工具调用在会话主时间线可见。

**Architecture:** Bridge 使用只读令牌与托管写令牌分离权限，所有 MCP 状态变更复用 AgentHub 与 WorkflowRuntime。Runtime 适配层从统一绑定生成启动配置；Renderer 直接按时间顺序展示持久化的工具事件。

**Tech Stack:** TypeScript、Node.js HTTP、MCP JSON-RPC、Electron、React、Vitest

---

### Task 1: 统一 Workflow MCP 启动绑定

**Files:**
- Modify: `src/automation/engine/main/hub/runtime/executor/workflow/workflow-mcp-launch.ts`
- Modify: `src/automation/engine/main/hub/runtime/executor/codex/codex-workflow-mcp.ts`
- Modify: `src/automation/engine/main/hub/runtime/executor/runtime-mcp.ts`
- Modify: `src/automation/engine/main/hub/runtime/executor/hermes/hermes-executor.ts`
- Modify: `src/automation/engine/main/hub/runtime/executor/opencode/opencode-executor.ts`
- Modify: `src/automation/engine/main/hub/runtime/executor/openclaw/openclaw-executor.ts`
- Test: `src/automation/engine/main/hub/runtime/executor/workflow/workflow-mcp-launch.test.ts`
- Test: `src/automation/engine/main/hub/runtime/executor/codex/codex-workflow-mcp.test.ts`
- Test: Runtime executor tests for ACP-backed one-shot paths

- [x] 写失败测试，断言 Codex 配置包含 runId、nodeId 和托管令牌，并断言 ACP one-shot 节点获得 Workflow MCP Server。
- [x] 运行 `npx vitest run src/automation/engine/main/hub/runtime/executor/workflow/workflow-mcp-launch.test.ts src/automation/engine/main/hub/runtime/executor/codex/codex-workflow-mcp.test.ts`，确认因缺失环境变量而失败。
- [x] 引入统一 `WorkflowMcpBinding`，由适配器完整转换环境变量；让 ACP one-shot executor 使用带 MCP Server 的执行通道。
- [x] 重跑相关 Runtime 测试并确认通过。

### Task 2: Bridge 读写授权分离

**Files:**
- Modify: `src/automation/engine/main/bridges/mcp-bridge.ts`
- Modify: `src/main/services/automation-service.ts`
- Modify: `src/automation/engine/main/hub/agent-hub.ts`
- Modify: Workflow MCP launch option plumbing files
- Test: `src/automation/engine/main/bridges/mcp-bridge.test.ts`
- Test: `src/main/services/automation-service.test.ts`

- [x] 写失败测试，断言 discovery 文件中的 readToken 可访问查询路由但写路由返回 `READ_ONLY_CLIENT`，内存中的 managedToken 可以写。
- [x] 运行 Bridge 定向测试并确认授权断言失败。
- [x] 生成双令牌，将 managedToken 仅保留在主进程并注入托管 Runtime；按路由权限在 Bridge 二次鉴权。
- [x] 重跑 Bridge 与 Automation Service 定向测试。

### Task 3: Workflow 生命周期工具

**Files:**
- Create: `src/automation/engine/main/bridges/workflow-mcp-lifecycle.ts`
- Modify: `src/automation/engine/main/bridges/mcp-bridge.ts`
- Modify: `src/automation/engine/mcp/server.ts`
- Test: `src/automation/engine/main/bridges/mcp-bridge.test.ts`
- Test: `src/automation/engine/mcp/server.test.ts`

- [x] 写失败测试覆盖 `workflow_confirm`、`workflow_run`、`workflow_run_list`、`workflow_run_get`、`workflow_stop`、`workflow_intervention_resolve`、`workflow_script_input_submit` 和 `workflow_outputs_list` 的工具声明与路由。
- [x] 写失败测试覆盖过期 revision、错误 runId、重复 intervention 和只读客户端写入。
- [x] 运行 MCP Server 与 Bridge 测试，确认新工具尚不存在。
- [x] 在独立生命周期模块中完成输入解析、安全投影、稳定错误码和 AgentHub 调用；Bridge 只负责授权与路由分发。
- [x] 重跑 MCP Server 与 Bridge 测试。

### Task 4: 结构化节点完成合同

**Files:**
- Modify: `src/automation/engine/main/bridges/workflow-mcp-lifecycle.ts`
- Modify: `src/automation/engine/main/bridges/mcp-bridge.ts`
- Modify: `src/automation/engine/main/workflows/v2/workflow-v2-conversation-manager.ts`
- Test: `src/automation/engine/main/bridges/mcp-bridge.test.ts`
- Test: `src/automation/engine/main/workflows/v2/workflow-v2-conversation-manager.test.ts`

- [x] 写失败测试，断言节点完成必须匹配 workflowId/runId/nodeId，错误身份返回稳定 code，工具结果优先于普通 JSON 文本。
- [x] 运行测试确认现有仅回显 output 的实现不能满足身份校验。
- [x] 复用 Run 快照验证节点身份并归一化结构化 output；保留对不支持 MCP Runtime 的文本兜底。
- [x] 重跑 Conversation Manager、Workflow Runtime 与 Bridge 测试。

### Task 5: 节点会话工具时间线

**Files:**
- Modify: `src/automation/engine/renderer/src/pages/workflow/WorkflowNodeAgentWindow.tsx`
- Modify: `src/automation/engine/renderer/src/pages/workflow/WorkflowNodeAgentWindow.test.tsx`
- Modify: workflow page stylesheet containing `workflow-node-agent-*`

- [x] 写失败测试，断言 tool call/result 位于主时间线而不是 `Runtime details`，且 `workflow_node_complete` 显示结构化完成标签。
- [x] 运行 `npx vitest run src/automation/engine/renderer/src/pages/workflow/WorkflowNodeAgentWindow.test.tsx` 并确认失败。
- [x] 按时间顺序渲染 user、assistant 和 tool 事件，只把 system 事件留在运行时详情；增加可折叠工具参数与结果样式。
- [x] 重跑组件测试。

### Task 6: 文档、发布说明与验证

**Files:**
- Modify: `docs/workflow-improvement-roadmap.md`
- Create: `.release-notes/workflow-mcp-lifecycle.md`

- [x] 在路线图第二项记录设计文档链接和完成范围。
- [x] 编写只描述用户可见结果的发布说明，包含一个标题和 `## 新增功能` 条目。
- [x] 运行本计划涉及的全部 Vitest 文件。
- [x] 运行 `npm run typecheck`、`npm run build` 和按 `origin/main-2.0` 计算的 release-note check。
- [x] 复核 `git diff --check`、工作区状态以及 `.idea/` 未被修改或纳入提交。

### Task 7: 生命周期边界完善

- [x] 将各 Runtime 适配器收敛为统一 `WorkflowMcpBinding` 输入，并补齐 Claude、Codex、ACP 及 ACP Runtime 矩阵测试。
- [x] 为状态和时间筛选、人工介入 reason、结构化完成 proposal 增加严格校验。
- [x] 为未授权、只读、无效输入、身份冲突、重复 intervention 和内部异常提供稳定错误对象。
- [x] 为输出增加媒体类型、大小和最多 4 KiB 的脱敏文本预览，不返回绝对路径或二进制内容。
- [x] 保证 ACP one-shot 在成功、失败和中断路径释放会话，且清理异常不覆盖节点执行结果。

## 自审结果

- 设计中的权限、生命周期工具、Runtime 注入、结构化完成和前端可观测性均有对应任务。
- 所有生产代码任务均先写失败测试再实现。
- 新的领域模块只隔离生命周期、安全投影和稳定错误边界，不为单一调用增加透传包装。
- 完整仓库基线在 Windows 上已有无关失败；完成判断使用本任务定向测试、typecheck、build 和 release-note check，并单独报告既有失败。
