# AgentRecall Evaluation 原生迁移设计

## 背景

AgentRecall 已原生接入 Runtime、MCP 与 Workflow，但还缺少一条可重复验证 Agent 输出质量的链路。同级项目 Multi Agent Chat 在提交 `ef81808a8e0258bb157cc98d3aadd8be837b3540` 中已有完整 Evaluation 实现。本次以该提交为只读基线，把数据集、评估器、实验运行与历史结果迁入 AgentRecall；不读取或修改 Multi Agent Chat 当前工作区和用户数据。

## 目标

- 新增一级 Evaluation 页面，提供概览、数据集、评估器和实验四个视图。
- 数据集支持维护多条输入与可选期望输出。
- 评估器支持包含匹配、精确匹配、合法 JSON 和 LLM Judge。
- LLM Judge 提供可编辑模板，并复用 Runtime 中已有的执行配置。
- 实验可选择目标 Agent、数据集、多个评估器和 1–5 次重复运行。
- 展示单 Case 输出、评分理由、通过状态、耗时、实验汇总与运行历史。
- Evaluation 数据写入 AgentRecall 自己的 `automation.db`，与会话索引和 Multi Agent Chat 数据隔离。

## 不包含的范围

- 不自动运行回归评测，不增加定时任务或后台队列。
- 不导入 Multi Agent Chat 的 Evaluation 数据。
- 不新增另一套 Provider 或模型配置；目标 Agent 与 Judge 都来自现有 Runtime 页面。
- 不增加 Eval 结果云同步、排行榜或团队协作。
- 不改变 Multi Agent Chat 的代码、数据库或配置。

## 架构

```text
EvaluationFeaturePage
  └─ EvaluationPage / useEvaluationWorkbench
          │ window.sessionSearch.automation
          ▼
Typed preload Evaluation API
          │ automation:evaluation:* + Zod validation
          ▼
Electron Main
  ├─ EvaluationService
  │    ├─ EvaluationStore ── automation.db
  │    ├─ runEvaluation
  │    └─ ConfiguredAgentExecutionService
  └─ AgentHub.askWorkflowAgent
          │
          └─ existing Runtime adapters
```

Evaluation runner 与存储作为自动化引擎领域代码放在 `src/automation/engine/`。AgentRecall 自己的服务负责生命周期、Runtime 适配、IPC 校验与产品级错误信息。Renderer 不访问数据库或进程，只使用 preload 暴露的窄 API。

## 数据与运行链路

### 数据集

一个数据集包含名称、描述和有序 Case。每个 Case 至少有输入，可选期望输出与结构化 metadata。保存时使用事务整体替换 Case，避免编辑过程中出现半份数据。

### 评估器

- `contains`：规范化后检查输出是否包含期望文本。
- `exact_match`：规范化后检查输出与期望文本完全一致。
- `json_valid`：检查输出能否解析为 JSON。
- `llm_judge`：渲染 Case 输入、期望输出和实际输出到评分 Prompt，再由选择的 Runtime Channel 对应执行 Agent 返回结构化评分。

模板只负责生成可编辑评估器，不在运行时覆盖用户 Prompt。Judge 输出解析失败时，该评分明确失败并保留原因，不能静默通过。

### 实验

实验保存目标 Agent、数据集、评估器列表和重复次数。运行前主进程重新读取这些对象并验证引用；Renderer 提交的对象不能直接驱动执行。每个 Case 使用 fresh one-shot 执行，避免上一个 Case 的会话上下文污染下一个 Case。

运行完成后保存：Agent revision、每次 Case 的输入/输出/错误/耗时、每个评估器的 score/reason/evidence，以及平均分、最低分、通过率和总耗时。一次实验中某个 Case 执行失败时仍保留其他 Case 的结果，运行状态标记为失败。

## Runtime 复用

目标 Agent 使用 Runtime 页面中的 configured Agent。执行服务解析 Agent 的 Channel、模型和 reasoning effort，并通过 `AgentHub.askWorkflowAgent` 发起 `oneshot + fresh` 请求，工作目录使用当前 Automation 工作目录。

LLM Judge 保存的是 Runtime Channel ID。运行时选择该 Channel 上可执行或受管的 configured Agent；找不到时给出可操作错误，提示先在 Runtime 中配置对应 Agent。凭据不进入 Eval 数据、运行结果或 Renderer 快照。

## 存储与生命周期

`EvaluationStore` 使用 Node SQLite 的独立连接访问现有 `automation.db`，启用 WAL 和外键。表名沿用 Evaluation 领域前缀，与 AgentHub 和 MCP 表隔离。`NativeAutomationService` 构造并持有 `EvaluationService`，应用关闭时在 Automation 数据库生命周期内关闭 Evaluation Store。

不在启动时预加载全部 Eval 数据；进入页面后才通过四个并行 list 调用加载。空数据库只创建表，不创建示例记录。

## IPC 与安全边界

所有通道使用 `automation:evaluation:*` 前缀：

- 数据集 list/save/delete。
- 评估器 list/save/delete。
- 实验 list/save/delete/run。
- 运行记录 list/delete。

主进程使用 Zod 校验 ID、名称、字符串长度、Case 数量、threshold、repetitions、Evaluator ID 数量和 metadata 结构。运行请求只接受实验 ID。数据库查询与执行错误返回用户可读信息，不回传凭据、环境变量或内部堆栈。

## UI

左侧导航在 Workflow 后加入 `Eval`，图标使用 Beaker。页面继续使用 AgentRecall 的现有窄侧栏、主题和 Automation 工作区样式，不复制 Multi Agent Chat 的应用壳。

页面内部保留四个视图：

- 概览：资源数量、平均分、通过率、最近实验和失败 Case。
- 数据集：左侧数据集列表，右侧编辑 Case。
- 评估器：左侧评估器列表，右侧规则、门槛、Judge Runtime 与 Prompt。
- 实验：左侧实验列表，右侧配置、运行结果和历史。

未保存编辑在切换 Eval 子视图或离开应用时得到保护。加载和执行状态局部显示，不阻塞工作台、会话或其他 Automation 页面。

## 测试与兼容性

- Store 测试只使用临时目录和合成数据。
- Runner 测试使用假的 Agent 执行函数，不启动真实 Runtime。
- Service 测试验证 Agent/Channel 解析、fresh one-shot 和 Judge 选择。
- IPC 测试验证通道前缀、输入边界与委托。
- preload 测试验证每个方法映射到正确通道。
- UI 合同测试验证一级导航和页面挂载。
- TypeScript、Vitest、构建与 release note 检查全部通过后，才启动开发版供人工查看。
