# AgentRecall v2 使用指南

[返回项目首页](../../README.md)

AgentRecall v2 是预览版，提供会话搜索和整理，也包含 Runtime、Agent、Chat、Workflow、Eval、MCP、目录记忆和 Skill 库。

v2 使用独立的启动命令、应用数据和数据库，可以和 v1 同时运行，默认不会自动读取 v1 数据；如需迁移，可在 **设置 → 关于 → V1 数据迁移** 中手动导入。

## 1. 安装与快速开始

AgentRecall v2 支持 macOS 和 Windows，需要 Node.js 22.13 或更高版本。安装最新的 v2 Release：

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/download/v2-latest/agent-recall-v2.tgz
agent-recall-v2
```

后续在任意终端运行即可启动：

```bash
agent-recall-v2
```

应用会自动准备本地数据服务，不需要另外安装 PostgreSQL。

macOS 上不想每次从终端启动时，可以生成一个本地启动器，之后从 Launchpad、Spotlight 或 Dock 打开：

```bash
agent-recall-v2 install-app
```

启动时会自动检查更新，也可以主动检查或直接更新，App 内还可以在 **设置 → 关于** 检查并安装：

```bash
agent-recall-v2 --check-update
agent-recall-v2 --update
```

完整的安装、更新、回滚、卸载和国内镜像说明见 [Install.md](../../Install.md)。参与开发请看 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

首次打开后，只需完成与你相关的步骤：

1. 如果只想搜索历史会话，打开 **Session**，点击 **更新索引**。Claude Code 和 Codex 默认启用。
2. 如果还使用其他编码 Agent，在 **设置 → 可选来源** 中开启对应来源，再更新索引。
3. 如果要使用 Chat、Workflow 或 Eval，先在 **Runtime** 中准备执行配置并创建 Agent；如果要从 Codex 或 Claude Code 使用 AgentRecall 工具，直接打开 **MCP** 连接客户端。
4. 如果要使用 AI 摘要或 AI 找会话，在 **Provider → AI 摘要与搜索** 中选择服务。

应用启动后会常驻菜单栏或系统托盘。默认终端、全局快捷键、主题和语言都可以在设置中调整。

## 2. 准备 Runtime 和 Agent

Chat、Workflow 和 Eval 依赖 Runtime 中保存的 Agent。第一次使用这些功能前，先完成本节；MCP Gateway 与 Runtime Agent 无关。

### 理解三个概念

| 概念 | 用途 |
| --- | --- |
| Runtime 执行配置 | 决定使用哪个执行器，以及该执行器支持的 Provider、凭据、模型和插件配置 |
| Agent | 从某个执行配置中选择模型并保存为可复用角色 |
| Provider 页面 | 管理本机 Codex、Claude Code，以及会话摘要和 AI 搜索所使用的服务 |

Runtime 执行配置负责 v2 自动化能力，Provider 页面负责本机工具和会话 AI 功能，两者不是同一个配置入口。

### 创建执行配置

进入 **Runtime → 执行配置**：

1. 点击 **新增配置**，选择 Codex、Claude Code、API、Hermes、OpenCode、OpenClaw 或 DeepSeek Harness。
2. 已在本机配置过的执行器可以尝试 **一键导入本地默认配置**。
3. 选择 Provider，按需填写 API Key，并确认可用模型。
4. Codex 配置还可以选择需要启用的插件。
5. 点击 **测试**检查配置是否可用，再点击 **保存配置**。

部分 Provider 支持余额查询。连接、环境变量或请求覆盖等选项位于高级配置中，没有特殊需求时保持默认即可。

#### 使用 DeepSeek Harness

DeepSeek Harness 使用官方 `dsh` CLI。当前版本要求 Node.js 22.19.0 及以上的 22.x，或 Node.js 24 及以上版本（不支持 Node.js 23），请先确保下面的命令可用：

```bash
npm install -g @deepseek-ai/dsh
dsh --version
```

随后可运行 `dsh web` 完成模型和凭据设置，再回到 AgentRecall：

1. 新建 **DeepSeek Harness** 执行配置；如果使用了自定义 Harness home，在高级配置中设置 `DSH_HOME`。
2. 点击 **一键导入本地默认配置**，让页面显示当前 `settings.yaml` 中的模型。
3. 创建 Agent 时选择 **Default** 模型，然后运行配置测试。

当前官方标准入口是 `dsh --profile headless "<task>"`。它每次创建一个 fresh 会话，只在结束时返回最终文本，不提供单次模型覆盖、会话续接或 AgentRecall 自定义 MCP 注入。因此：

- AgentRecall 不会改写 DSH 的 `settings.yaml` 或凭据文件，模型与凭据继续由 DSH 管理；
- Chat、Workflow 和 Eval 的每次调用都是独立运行，界面不会宣称保留 DSH 上下文；
- DSH 会为 Chat、Workflow、Eval 和配置测试的每次调用创建并持久化 fresh session；这些记录会保留在 `$DSH_HOME/sessions`，当前官方 headless 入口没有删除 API，AgentRecall 不会自动清理；
- 非 `Default` 模型会被明确拒绝，避免看似切换成功、实际仍使用 DSH 默认模型；
- 如果需要交互式续接或 MCP，请改用支持相应能力的 Runtime。

### 创建 Agent

切换到 **Runtime → Agent**，点击 **新建 Agent**，然后选择：

- Runtime 类型。
- 对应的执行配置。
- 默认模型。
- Codex 模型支持的推理强度。
- 名称、描述和标签。

保存后，这个 Agent 就可以出现在 Chat、Workflow、Eval 和 MCP 的选择列表中。Agent 只保存可复用的执行身份；具体会话是否延续，由 Chat 或其他使用场景决定。

## 3. 工作台

工作台集中显示当前设备上的主要状态：

- 会话数、消息数、Token 用量、缓存率和来源分布。
- Claude Code、Codex 的额度。
- 最近会话、Workflow 和 Chat 工作室。
- Runtime、MCP、Memory 和 Skills 的当前状态。

在会话卡片中搜索会跳转到 Session 页面。点击最近会话可以打开详情；来源支持 Resume 时，也可以直接继续会话。

用量可以切换今天、7 天、30 天和全部时间。点击趋势图中的某一天，会进入 Session 页面并只显示当天的会话；点击日期标签旁的关闭按钮可以取消单日筛选。

点击 **调整布局**可以拖动卡片或使用前移、后移按钮改变顺序。布局会保存在当前设备上。

## 4. 搜索、查看和整理 Session

Session 页面用于索引、搜索、查看和整理不同编码 Agent 的历史会话。

### 会话来源

| 类型 | 包含的来源 |
| --- | --- |
| 默认来源 | Claude Code CLI、Claude Desktop、Codex CLI、Codex Desktop |
| 可选来源 | CodeBuddy、WorkBuddy、CodeWiz、TClaude、TCodex、OpenClaw、Hermes、OpenCode、ZCode、Cursor Agent、Trae、Qoder |
| 扩展环境 | SSH 远程环境、Windows WSL |

可选来源默认关闭，需要先在 **设置 → 可选来源** 中开启。不同来源支持的 Resume、迁移、删除、同步和用量统计能力不同，页面只会显示当前可执行的操作。

WorkBuddy 首版是只读本地来源，可搜索、查看和导出会话中的消息、工具轨迹、标题及用量信息；暂不支持实时跟踪、Resume、迁移、同步或从 AgentRecall 打开 WorkBuddy。

### AgentRecall 发起的 Runtime 会话

Workflow、Eval、Team Chat、Agent、Skill 探索和配置测试所调用的 Runtime 会被记录为 AgentRecall 调用。由这些调用新建的 Session 默认收在 **AgentRecall 调用**分组中，不会挤占普通会话列表；分组标题会显示当前搜索条件下的匹配数量。

展开分组后，可以查看全部 AgentRecall Session，或继续按 Workflow、Eval、Team Chat、Agent、Skill 和系统任务筛选。切换到 **全部**会同时显示普通 Session 与 AgentRecall 创建的 Session。收藏、标签、隐藏和批量操作仍按原有规则工作，自动归组不会修改这些状态。

Session 详情会显示关联调用的用途、状态、时间和可用的业务返回入口。Workflow 运行记录、Eval 结果和 Team Chat 消息也可以直接打开对应 Session。如果 Runtime 尚未返回 Session 引用、Session 仍在等待索引，或业务记录没有可追溯的调用，页面会分别显示原因。

### 搜索和筛选

在 Session 页面按 `Cmd+F`（macOS）或 `Ctrl+F`（Windows）聚焦搜索框，输入关键词后按 Enter。

还可以用这些条件缩小范围：

- 左侧的环境、项目和项目标签。
- 来源列表。
- 收藏和隐藏视图。
- 顶部的全部、进行中和已结束状态。
- 今天、7 天、30 天或全部时间。
- 最近搜索记录。
- 普通会话、AgentRecall 调用、全部会话及 AgentRecall 调用类型。
- **AI 找会话**，用自然语言描述要寻找的内容。

选中的环境、项目、标签或单日范围会显示在搜索框附近，点击对应条件即可清除。

### 查看完整会话

点击结果打开详情。页面会显示消息、Markdown、代码块、工具调用、附件、会话状态和来源信息。

在详情页可以：

- 只看全部、用户或助手消息。
- 显示或隐藏工具调用。
- 查看命中关键词附近的上下文。
- 查看关联的主会话和子 Agent 会话。
- 为会话生成或更新 AI 摘要。

在详情页按 `Cmd+F` 或 `Ctrl+F` 会打开会话内查找。Enter 跳到下一个匹配，Shift+Enter 返回上一个，Esc 关闭查找。

### 整理、继续和导出

可以重命名会话、添加标签或收藏。隐藏会话位于右键菜单，隐藏后可以从左侧 **隐藏**视图中找回。

根据会话来源，详情页还会提供：

- **Resume**：使用设置中的默认终端继续原会话。
- **复制命令**：复制 Resume 命令后手动运行。
- **迁移到**：为支持的目标编码 Agent 创建一个新会话，不覆盖原会话。
- **导出 MD / JSON / 纯文本**：保存会话内容；JSON 的具体结构取决于原始会话来源。
- **保存到远程**：把当前会话上传到自己的 Supabase 项目。
- **删除**：删除选中的会话或缓存；具体影响会在确认窗口中说明。

模型请求 JSON 可能包含完整提示词、工具参数和回复，请保存在可信目录中。

SSH 环境中的 Claude Code 和 Codex 会话可以在同一台远程主机上互相迁移。迁移完成后，AgentRecall 会打开一个新终端，重新连接原 SSH 主机并自动 Resume 新会话。

### SSH、WSL 和跨设备同步

在 **设置 → 连接** 中添加 SSH 主机；Windows 用户还可以添加 WSL 发行版。连接成功后，对应环境和项目会显示在 Session 左侧。SSH 中的 Claude Code 和 Codex 会话支持在原主机上互相迁移。

点击 Session 右上角的云朵按钮打开远程会话：

1. 在 **设置 → 远程同步** 中填写自己的 Supabase 项目信息并完成首次配置。
2. 手动上传会话，或为 Claude Code、Codex 安装自动同步 Hook。
3. 在另一台设备使用相同配置，搜索、查看并恢复云端会话。

本地和云端都发生变化时会显示内容冲突。可以选择用本地版本更新云端，也可以把云端版本恢复成新的本地副本。删除云端副本不会删除本地会话。

## 5. 使用多 Agent Chat

Chat 让多个独立 Agent 在同一个项目目录中协作。使用前，需要先在 Runtime 中创建至少一个 Agent。

### 创建工作室

点击 **新建房间**，填写房间名称和可选的工作目录，然后添加员工：

- 每名员工选择一个已保存的 Agent。
- 可以为员工设置更适合当前房间的显示名称。
- 同一个 Agent 可以添加多次并承担不同角色。
- 一个房间最多可以添加 24 名员工。

每名员工拥有独立会话，不会与其他员工共享对话上下文。

### 发送消息

不带 `@名称` 的消息只会记录到房间，不会调用任何 Agent。需要 Agent 处理时，可以：

- 在输入框中输入 `@名称`。
- 在 **发送给**中选择一个或多个员工。
- 点击右侧员工，把它加入本轮接收者。

Enter 发送，Shift+Enter 换行。Agent 回复生成期间可以停止本轮。

员工首次回复后，支持持续会话的 Runtime 会继续沿用该员工的上下文；不支持延续的 Runtime 每次使用新上下文。点击员工旁的 **开始新会话**只会重置该员工，不影响房间中的其他成员。

房间还支持修改名称、继续添加员工、加载更早消息和归档。永久删除会同时删除这个工作室的 Chat 数据，操作前请确认内容不再需要。

## 6. 创建和运行 Workflow

Workflow 把一个任务拆成可重复运行的 Agent 或脚本节点，并保留每次运行的状态和产出。

### 从任务生成流程

点击 **新建 Workflow**：

1. 选择工作目录，以及负责规划的 Agent 和模型。
2. 输入希望完成的任务，点击 **开始**。
3. 回答 Workflow Agent 对目标、输入、输出和约束的追问。
4. 信息足够后，点击 **生成流程图**。
5. 检查节点、依赖关系、输入和输出。
6. 如有需要，选择另一个 Agent 执行独立 Review。
7. 处理 Review 中的阻塞问题后，确认当前 Workflow 版本。

确认前仍可以调整节点及其 Agent。包含外部操作的流程还会要求选择相应的审批方式。

### 运行和处理待办

点击 **运行 Workflow**后，页面会显示每个节点的状态、执行 Agent 和产出。运行期间可能需要你：

- 回答节点提出的问题。
- 批准或拒绝脚本权限。
- 暂停、继续或停止节点。
- 接受或拒绝节点的完成结果。
- 在输出面板中查看文件、文档和其他产物。

需要处理的节点会自动打开。全部节点完成后，可以查看最终报告、节点消息和登记产物。

### 运行历史和恢复

**运行历史**可以按状态、触发来源、流程版本和时间筛选。每次运行会保留节点时间线、消息、输入、输出、Token 用量和产物快照。

运行异常时，页面会根据当前状态提供继续、回到保存点、保留现场或放弃恢复等操作。发生文件冲突时，先查看差异，再确认如何处理。

## 7. 评估 Agent

Eval 用固定输入重复运行 Agent，帮助比较输出质量和观察后续变化。

### 创建数据集

进入 **Eval → 数据集**，创建数据集并添加 Case。每个 Case 包含输入，也可以填写期望输出。

### 创建评估器

进入 **评估器**，选择判断方式：

- **包含期望内容**。
- **完全匹配**。
- **有效 JSON**。
- **LLM Judge**。

评估器可以调整通过阈值，也可以暂时停用。LLM Judge 需要单独选择执行评判的 Runtime 配置，并填写完整评分标准；模板菜单提供了几种常见评判方式。

### 创建并运行实验

进入 **实验**，选择：

- 要测试的 Agent。
- 一个数据集。
- 一个或多个评估器。
- 每个 Case 的重复次数，范围为 1–5 次。

运行后可以查看平均分、最低分、通过率和耗时，也可以展开每个 Case 查看 Agent 输出、各评估器得分和失败原因。概览页会汇总近期实验、失败 Case 和整体通过率。

## 8. 通过 MCP Gateway 使用工具

MCP 页面只有一个工具入口。AgentRecall 为 Codex 和 Claude Code 各维护一个名为 `agent-recall` 的 Gateway 配置，不再把工具服务绑定到 Runtime Agent。AgentRecall 需要保持运行，Gateway 才能访问页面中已启用的工具。

点击页面右上角的 **连接客户端**，可以在弹窗中查看 Codex、Claude Code 的检测状态、配置文件路径，并单独连接或断开。连接即表示信任 AgentRecall Gateway：Codex 和 Claude Code 调用它开放的工具时不会重复请求批准；断开时会同时移除 Gateway 和这项信任。应用启动时会修复已启用且已检测到的客户端配置；手动断开后不会在下次启动时自动重连。修改连接后需重启对应客户端。

### 两层工具入口

Gateway 对外固定开放七个工具：

- `list_skills`、`get_skill`、`search_sessions`、`get_session` 是高频直接工具。
- `search_tools` 返回紧凑、可分页的工具列表，也可以用 `sourceId` 只查看一个工具源；它不做语义匹配。
- `get_tool` 根据稳定的 `toolRef` 返回完整说明和输入 Schema。
- `call_tool` 根据同一个 `toolRef` 调用已启用的实际工具。

四个直接工具和三个 Gateway 工具不会重复出现在通用索引中。依赖当前 Workflow Run、Review Revision 或 Studio 房间上下文的临时工具也不会进入全局索引，只在对应执行上下文中使用。

### 管理工具源

点击 **新建 MCP Server** 可以添加 STDIO 或 HTTP 工具源。保存新连接或修改连接配置时，AgentRecall 会自动读取并保存工具目录；也可以随时手动测试。刷新失败时保留上一次成功目录，同时显示本次错误。

页面中的工具源开关和单个工具开关是 Gateway 的开放边界：关闭后配置仍保留，但外部客户端无法再通过索引或直接工具调用它。内置 Session、Skill 和 Workflow 工具源与自定义工具源都在同一页面管理。

## 9. 使用目录 Memory

目录 Memory 为主动选择的项目目录建立彼此隔离的长期记忆，默认关闭。

### 完成首次准备

进入 **设置 → Memory**：

1. 开启 **目录记忆**。
2. 下载 OpenViking 运行组件。
3. 下载页面提供的本地向量模型。
4. 启动服务并确认状态正常。

开启总开关不会自动下载组件，也不会自动选择任何目录。首次准备需要下载额外文件，CPU 即可运行本地向量模型。

### 管理项目目录

打开 **Memory**，点击 **管理目录**或**添加目录**。确认后，应用只会增量捕获在该目录中后续新产生的 Agent 对话，不会批量导入已经索引的历史会话。

可以随时停止或恢复目录跟踪。目录移动后可以重新关联。每个受管理目录都有独立的 OpenViking 用户、会话、记忆和索引，不会与其他目录混用。

选择一个目录后可以：

- 搜索已有记忆并查看详情。
- 新建、修改或删除手动记忆。
- 查看后续对话提炼出的只读记忆。
- 停止管理目录但保留已有数据。
- 永久删除该目录在 Memory 中的数据。

历史会话仍保留在 AgentRecall 的 Session 搜索中。需要复用旧信息时，先搜索并阅读对应会话，再手动保存确认有价值的内容，或明确让 Agent 将其记为长期记忆。

### 开启自动召回和记忆

在 **设置 → Memory** 中，可以分别为 Claude Code、Codex 和 OpenCode 开启自动召回与记忆。只有受管理目录内的事件会被处理。

Agent Hook 会先把新 Turn 增量追加到 OpenViking。达到上下文阈值、明确要求记住内容、会话空闲或结束时，OpenViking 才会提交归档，并在后台调用已配置的模型完成摘要、检索已有记忆、判断新增或更新内容以及索引写入；因此“已追加对话”不等于“记忆已完成提炼”。

只为确认过的项目目录开启这项能力，避免把不相关项目加入同一个记忆范围。

目录 Memory 与 **设置 → Skills** 中跨设备同步的 Memories 不是同一功能：前者服务于选定项目的长期记忆，后者同步支持的编码 Agent 记忆文件。

## 10. 管理 Skills

Skills 页面包含 **本 App Skill**和**本地 Skill**两个区域。

### 把 Skill 加入本 App

有两种来源：

- 在 **本地 Skill**中查看本机已有 Skill，按来源筛选、预览 `SKILL.md`，再点击 **加入本 App**。
- 点击 **发现 Skill**，浏览 skills.sh 榜单、按关键词搜索，或描述需求让 AI 匹配公共 Skill。

从公共仓库加入 Skill 时，会先进入 AgentRecall 的 Skill 库，不会自动安装到任何编码 Agent。

### 选择安装目标

在 **本 App Skill**中打开 Skill 详情，点击 **管理安装**，选择 Codex、Claude Code、CodeBuddy、Qoder、Trae 或 Pi。

这里的安装目标是本机编码 Agent，不是 Runtime 页面中创建的可复用 Agent。除了 Codex 私有目录外，还可以选择 **Codex shared (`~/.agents/skills`)**，适合让多个 Codex 工作区共用同一份 Skill；Windows 下对应用户目录中的 `.agents\skills`。如果目标目录已有同名内容，页面会显示冲突，普通安装不会覆盖；只有对该目标明确选择 **强制安装**后，保存时才会替换已有内容。

### 跨设备同步 Skill

在 **设置 → Skills** 中配置自己的 Supabase 项目并启用同步后，可以：

- 上传符合条件的本 App Skill。
- 保存多个云端版本。
- 比较本地与云端文件差异。
- 在另一台设备把云端 Skill 加入 Skill 库。
- 恢复指定历史版本。

云端 Skill 会在 **本 App Skill** 左侧单独显示为“仅云端”，选中后可以直接预览任意版本，再加入本 App，不需要先找到一个同名的本地 Skill。

系统、项目或插件管理的 Skill 不一定支持上传。AI 探索公共 Skill 时，可以在设置中指定使用哪个 Runtime；自动模式会选择第一个可用 Runtime。

## 11. Provider、同步与常用设置

### Provider

Provider 页面有三个独立目标：

- **Codex**：使用现有官方认证，或配置 OpenAI-compatible 服务。
- **Claude Code**：使用现有官方认证，或配置 Anthropic-compatible 服务。
- **AI 摘要与搜索**：选择 Codex、Claude Code，或直接调用自定义 API。

Codex 和 Claude Code 配置可以只保存在 AgentRecall 中，也可以通过单独按钮写入对应工具。AI 摘要与搜索的设置只用于会话摘要、AI 找会话和相关会话处理，不会创建新的编码 Agent 会话。

Chat、Workflow 和 Eval 使用的模型统一在 **Runtime → 执行配置**中管理。

### 远程同步

会话同步与 Skill 同步分别在 **设置 → 远程同步**和**设置 → Skills**中配置，都使用你自己的 Supabase 项目。

- 会话同步支持手动上传、Claude Code / Codex Hook、附件同步、云端查看和恢复。
- Skill 同步保存本 App Skill 的云端版本。
- Rules 和 Memories 同步使用 Skill 同步区域配置的 Supabase 项目，可按需分别开启。

这些同步功能默认关闭。关闭同步不会自动删除已经保存的云端数据。

### 常用设置

- **默认终端**：选择 Resume 使用的终端。
- **全局快捷键**：修改系统级打开窗口快捷键，并查看应用内快捷键。
- **连接**：添加和诊断 SSH、WSL 环境。
- **可选来源**：开启 Claude Code、Codex 之外的会话来源。
- **剩余额度**：隐藏不使用的 Claude Code 或 Codex 额度卡片。
- **AI**：设置自动摘要、迁移压缩和会话检索 MCP。
- **Memory**：准备目录记忆组件并选择自动召回来源。
- **Skills**：选择 AI 探索 Runtime，并配置 Skills、Rules 和 Memories 同步。
- **外观**：切换主题、语言和 macOS Dock 显示方式。

v2 仍是预览版。执行 `agent-recall-v2 --update`，或在 **设置 → 关于** 中检查并安装更新。
