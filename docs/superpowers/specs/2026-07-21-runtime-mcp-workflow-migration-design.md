# AgentRecall Runtime、MCP 与 Workflow 原生迁移设计

## 背景

AgentRecall 2.0 已将首页调整为面向日常继续工作的工作台，并为 Workflow 留出了稳定位置。当前应用仍只负责会话检索、恢复、统计、Skills、Provider 与目录记忆；它无法在应用内配置执行 Runtime、管理通用 MCP Server，或创建和运行多 Agent Workflow。

同级项目 Multi Agent Chat 已经实现一套完整的 Runtime、MCP 与 Workflow V2 执行链。本次工作以其当前 `main` 版本为只读参考，将相关能力原生迁入 AgentRecall。Multi Agent Chat 的代码、工作区、本地数据库和用户配置均不被 AgentRecall 修改，也不成为 AgentRecall 运行时依赖。

## 目标

- 在 AgentRecall 内原生配置并测试 Codex、Claude Code、API、Hermes、OpenCode 与 OpenClaw Runtime。
- 在 AgentRecall 内管理 MCP Server、发现工具、测试连接，并把 MCP 能力绑定给 Workflow 使用的 Agent。
- 在 AgentRecall 内完成 Workflow V2 的规划、校验、确认、执行、暂停、恢复、人工介入和输出查看。
- 使用 AgentRecall 自己的数据目录、数据库、配置、MCP bridge 与进程生命周期，不依赖 Multi Agent Chat 正在运行。
- 将 Workflow 的真实状态接入工作台预留区域，并提供独立的 Runtime、MCP、Workflow 功能页。
- 保持现有会话、Skills、Provider、Memory、同步与恢复能力不回退。
- 形成清晰的领域模块和窄 IPC，避免继续扩大现有 `App.tsx` 与主进程入口。

## 不包含的范围

- 不迁移 Multi Agent Chat 的 Chat、Tasks、Schedules、Teams、Evaluation 或顶层 Agent 管理页面。
- 不读取、移动或升级 Multi Agent Chat 的真实用户数据；本次不提供自动导入旧数据。
- 不把 Multi Agent Chat 作为子进程、WebView、动态链接库或运行时服务启动。
- 不在两个仓库之间建立 Git submodule、workspace、软链接或本地路径依赖。
- 不承诺自动跟随上游未来提交；迁移后由 AgentRecall 自己维护，设计文档记录参考基线便于人工对照。
- 不把 Provider 页与 Runtime Channel 强行合并。Provider 页继续服务于现有会话摘要、搜索和迁移配置；Runtime 页管理 Workflow 执行配置。

## 迁移策略

采用“只读参考、原生拥有”的迁移方式：

1. 从 Multi Agent Chat 当前 `main` 的实现和测试中识别领域合同与依赖闭包。
2. 在 AgentRecall 中按其现有分层重新落位，而不是保留另一个应用壳。
3. 对复制来的产品名、配置标记、环境变量、数据目录和 MCP discovery 名称做 AgentRecall 化，防止两个应用互相覆盖。
4. 优先保留行为合同与安全校验；页面视觉改用 AgentRecall 当前的导航、主题、密度和中英文体系。
5. 每个垂直切片通过测试后再接下一个切片，最终统一接入工作台。

参考基线为 Multi Agent Chat `main` 上包含 Workflow closure audit 的当前提交。该仓库在迁移期间保持只读。

## 总体架构

```text
AgentRecall Renderer
  ├─ Runtime page
  ├─ MCP page
  ├─ Workflow page
  └─ Workbench workflow summary
          │ window.sessionSearch
          ▼
Typed preload APIs
          │ validated IPC
          ▼
Electron Main
  ├─ AutomationService
  │    ├─ Runtime registry / router
  │    ├─ configured agents and channels
  │    └─ Workflow coordinator
  ├─ McpRegistryService
  ├─ WorkflowRuntime
  ├─ RuntimeApprovalBroker
  ├─ localhost MCP bridge
  └─ AutomationStore
          │
          ├─ automation.db
          ├─ runtime-channels.json
          └─ selected work directory outputs
```

Renderer 只接收可序列化快照、事件和明确的操作结果，不直接访问文件、数据库、Agent 进程或 MCP transport。主进程通过独立服务持有生命周期，AgentRecall 现有 `SessionStore` 不承担 Workflow 的高频运行状态。

## 模块边界

### Shared contracts

新增 `src/shared/automation/`，只保存跨进程需要的合同：

- Runtime catalog、Channel、模型与 configured Agent 类型。
- MCP Server、工具、绑定、连接状态与请求类型。
- Workflow V2 definition、plan、run、node、packet、review、intervention 与 snapshot 类型。
- IPC channel 名称及 Zod 输入校验。

共享层不得导入 Electron、Node 文件系统、数据库或 Renderer 组件。

### Main process

新增 `src/main/automation/`，按领域而不是按页面组织：

- `runtime/`：检测、driver registry、router、one-shot 与 interactive session、各 Runtime adapter。
- `mcp/`：注册表、transport client、工具发现、Agent 绑定、stdio server 与 localhost bridge。
- `workflow/`：草稿、规划、校验、冻结计划、scheduler、node executor、script governance、review、intervention、恢复与输出。
- `persistence/`：automation schema、repository、恢复、迁移和原子保存。
- `automation-service.ts`：Renderer 操作的单一业务入口，不暴露内部 Hub 对象。

现有主进程入口只负责构造服务、注册 IPC、转发事件以及在应用退出时释放 Agent 进程、MCP client、bridge、数据库和定时器。

### Renderer

新增 `src/renderer/src/features/runtime/`、`features/mcp/` 与 `features/workflow/`。每个 feature 自己维护：

- page 组件。
- controller hook。
- 展示模型与错误文案。
- 局部样式和组件测试。

应用级 `App.tsx` 只持有当前页面和必要的跨页快照，不承载 Workflow planner 或 Runtime 配置编辑逻辑。Workflow 页面中的画布、节点面板、历史、输出与审批弹窗继续拆分为独立组件，单个文件不扩展到数千行。

## Runtime

### 支持范围

迁入以下 Runtime：

- Codex
- Claude Code
- API
- Hermes
- OpenCode
- OpenClaw

每个 Runtime 通过 capability 声明真实支持的执行方式、流式事件、会话续接、停止、模型切换和清理能力。上层不根据 Runtime ID 伪造对称能力。

### 配置模型

Runtime 页管理两级对象：

- Channel：Runtime、Provider、Base URL、认证、模型目录、环境变量和插件配置。
- Agent profile：名称、Channel、默认模型和 system prompt，供 Workflow 节点复用。

为避免再增加独立 Agent 顶层页面，Agent profile 作为 Runtime 页中的次级 Tab。Workflow 选择 Agent profile，不直接拼接 Provider 配置。

Runtime 凭据通过现有安全键值边界保存；快照和日志只返回是否已配置，不返回明文。导入本机 Codex、Claude、Hermes、OpenCode 或 OpenClaw 配置必须由用户显式点击，不能在启动时扫描并复制凭据。

### 执行与审批

Workflow 使用统一 Runtime router 提交 one-shot 或 interactive 请求。Runtime adapter 负责原生命令、SDK/RPC、session identity、事件标准化、取消和清理。需要文件、命令或网络批准时，通过统一 approval broker 发到 Renderer；用户拒绝或窗口关闭必须终止对应等待，不留下悬挂 Promise。

## MCP

### 注册表

MCP 页支持：

- 新增、编辑、启用和删除 stdio / HTTP Server。
- 测试连接并发现工具。
- 查看最近测试状态和错误。
- 为 Agent profile 绑定 Server，并为每个绑定设置工具 allowlist。

注册表存入 AgentRecall 的 `automation.db`。删除 Server 时同步删除绑定，但不会修改 Agent 的外部配置文件。

### Agent 安装与 Workflow bridge

需要把 AgentRecall Workflow 工具安装到 Codex 等外部 Agent 时，必须由用户显式执行。受管配置块使用 `AGENT_RECALL` 标记、`agent_recall_*` Server 名和 AgentRecall 专属环境变量，不能识别、替换或删除 Multi Agent Chat 的受管块。

AgentRecall 启动只监听 `127.0.0.1` 的随机可用端口，并在自己的 userData 中写 discovery 文件。discovery 只包含本机连接信息和随机认证 token。stdio MCP Server 读取 AgentRecall discovery 后调用主进程 bridge，不直接打开数据库。

Workflow 规划会话按会话范围注入 `workflow_validate`、`workflow_create` 等工具。工具只能更新当前草稿，不能绕过用户确认直接运行 Workflow。

### 安全

- MCP env 中的值不出现在 Renderer 日志、错误详情或测试快照中。
- stdio command 与 args 使用参数数组启动，不通过 shell 拼接。
- HTTP transport 只接受 `http:` / `https:`，并设置连接与调用超时。
- tool allowlist 在主进程调用前强制检查，不能只靠 UI 隐藏。
- 安装外部配置前创建备份并使用同目录临时文件原子替换。

## Workflow V2

### 生命周期

Workflow 使用以下主链路：

```text
用户目标
  → 规划对话
  → definition 校验
  → generation review
  → 用户确认
  → frozen plan
  → scheduler 执行 ready nodes
  → 结果校验 / review / intervention
  → durable run state
  → 输出与最终报告
```

页面支持新建、重命名、删除、选择、编辑和克隆 Workflow；运行支持开始、停止、暂停节点、恢复、修订运行、回答交互节点、提交脚本输入和处理人工审批。

### 节点与数据流

- LLM 节点支持 one-shot 与 interactive。
- Script 节点只从显式 user、workflow、upstream 或 literal 来源绑定参数。
- DAG 校验必须覆盖重复 ID、缺失依赖、环、不可达节点、非法终止节点、输出字段和 Script 参数类型。
- Scheduler 只运行依赖已完成且资源锁可用的节点，并遵守并行度。
- Agent 节点输出通过结构化 packet 传给下游，不从自然语言 summary 隐式取值。
- 运行中的 definition 冻结；修改会生成新 revision，不原地改变正在执行的 plan。

### 脚本与人工介入

Script 节点执行前进行静态风险分析、参数校验和权限判断。高风险命令、目录外写入、网络访问或显式审批规则触发 intervention；Renderer 展示实际脚本、参数、工作目录与风险原因。Prompt 说明不能替代代码校验。

### 持久化与恢复

Workflow definition、revision、run、node state、事件、输入请求、审批、runtime conversation identity 与恢复信息写入 `automation.db`。运行输出状态采用事务更新；文件输出写入用户选择工作目录下的 `outputs/<workflowId>/<runId>/`。

应用异常退出后，下次启动把仍标记 running 的运行恢复为可判定状态：可安全续接的节点进入恢复流程，无法证明可续接的节点进入 paused/failed 并显示原因，不自动重复执行有副作用的 Script。

## UI 与导航

左侧纵向导航调整为：

- 工作台
- 会话
- Workflow
- Runtime
- MCP
- Skills
- Memory
- Provider
- 设置

页面沿用 AgentRecall 的 Geist 字体、明暗主题、紧凑行高、细边框和当前强调色，不复制 Multi Agent Chat 的应用壳或宽资源侧栏。

### Runtime 页面

Runtime 页使用 Runtime 列表、配置列表和详情编辑器三段式布局；窗口变窄时前两段收为可切换列表。页面顶部提供 `Channels` 与 `Agents` 两个 Tab，避免额外顶层 Agent 页面。

### MCP 页面

MCP 页左侧是 Server 列表，右侧是连接详情和工具列表；Agent bindings 使用详情内 Tab 或抽屉。凭据输入默认隐藏，测试和保存状态就地反馈。

### Workflow 页面

Workflow 页保留紧凑 Workflow 列表和主要工作区。创建阶段突出目标对话与 definition；确认后突出 DAG 和节点状态；运行时节点详情、审批和输出按需打开，不同时铺满所有面板。

画布使用 `@xyflow/react`，但基础创建、确认、运行和审批不能依赖拖拽才能完成。键盘焦点、Escape 关闭弹层、减少动态效果和最小窗口布局与现有应用一致。

### 工作台

工作台右侧 Workflow 区域接入真实摘要：

- 等待用户处理的运行优先。
- 其次显示正在运行和最近修改的 Workflow。
- 最多展示五条，不在首页加载完整事件或节点日志。
- 点击条目打开 Workflow 页并选中对应 Workflow/Run。
- 空状态提供“新建 Workflow”，不再显示“暂未迁移”。

## 数据与兼容性

- AgentRecall 使用独立 `automation.db` 和 `runtime-channels.json`。
- 数据库 schema 使用独立 migration version，不并入会话索引 schema。
- 应用升级只迁移 AgentRecall 自己的 automation 数据。
- Multi Agent Chat 的配置块、数据库、discovery 和输出目录不作为迁移源，也不被清理。
- Runtime 或 MCP 未配置时，Workflow 可浏览和编辑，但运行操作给出明确的修复入口。
- MCP Server 或 Runtime adapter 不可用时，只影响相关 Agent/节点，不阻塞会话搜索与其他页面启动。

## 错误处理与资源生命周期

- 所有 IPC 输入在主进程边界验证；错误响应使用稳定 code 和用户可读 message。
- Runtime、MCP 与 Workflow 初始化并行于会话索引首屏，不阻塞工作台和会话页面出现。
- 主进程维护正在执行的 run、interactive session、MCP client 和 approval waiter；应用退出时按顺序停止新任务、取消等待、关闭 child process/transport、flush 状态并关闭数据库。
- Renderer 重载后重新订阅快照和事件，不创建第二个执行引擎。
- 事件流使用 revision/sequence 去重；页面只应用比当前更新的新事件。
- 单个节点或 MCP 失败保留上下文、错误和可重试动作，不用全局空白页替代局部失败。

## 测试策略

采用垂直切片的测试驱动迁移：

1. Shared contracts：catalog、validation、planning、packet 与 schema 测试。
2. Runtime：检测、capability、driver、one-shot、interactive、取消、恢复和清理测试。
3. MCP：registry、transport、工具发现、allowlist、受管配置块、bridge 认证和超时测试。
4. Workflow：definition、planner、scheduler、script、review、intervention、持久化与恢复测试。
5. IPC/preload：输入拒绝、操作委托、事件订阅和敏感字段不泄漏测试。
6. Renderer：页面静态渲染、关键交互、错误/空状态、工作台摘要和导航测试。
7. 集成：用 fake Runtime 与 fake MCP 运行包含并行 LLM、Script 和人工 gate 的完整 Workflow。

所有涉及 HOME、CLI 配置、MCP 安装、Session discovery、SQLite 或输出目录的测试均使用临时 HOME、临时 userData、临时 npm prefix 和合成 fixture。测试覆盖 macOS 与 Windows 路径分支，不读取或修改开发机真实 Codex、Claude、Skills、Electron 或 Multi Agent Chat 数据。

## 发布与验收

- Runtime 页能检测并配置六种 Runtime，保存、导入、模型刷新、连接测试和错误反馈可用。
- Agent profile 可绑定 Channel/模型，并能被 Workflow 节点选择。
- MCP 页能管理 stdio/HTTP Server、测试并展示工具、配置 allowlist 和 Agent 绑定。
- AgentRecall Workflow MCP 安装不会覆盖 Multi Agent Chat 或用户手写的 MCP 配置块。
- Workflow 能从目标规划出合法 DAG，经用户确认后运行 LLM/Script/interactive 节点，并处理停止、输入、审批、修订和输出预览。
- 应用重启后 Workflow、run、节点状态和可恢复会话仍存在，脚本副作用不会因恢复被静默重复执行。
- 工作台显示最多五条真实 Workflow 状态，并可跳转到对应详情。
- Runtime/MCP/Workflow 初始化失败不阻塞现有工作台、会话、Skills、Memory 与 Provider 页面。
- Multi Agent Chat 仓库、数据目录、配置文件和运行进程保持不变。
- 在 1280×820 与 860×560、亮色与暗色主题下关键页面无横向溢出，键盘焦点和弹层关闭路径可用。
- 完整测试、类型检查、生产构建、release note 检查和敏感信息扫描通过。
