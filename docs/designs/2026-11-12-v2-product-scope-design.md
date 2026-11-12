# AgentRecall V2 产品范围与下一步设计

## 文档状态

- 状态：设计草案，待审阅。本文不改变任何现有行为，列出的改动都尚未实现。
- 适用范围：以 `apps/main-2.0` 为主；V1 只说明维护原则。
- 主要读者：决定 V2 做什么、不做什么的维护者。
- 依据：仓库 README、[功能规格](../spec/README.md)、[架构决策](../adr/README.md)、V2 导航和文中链接的源码。没有统计各功能的实际使用量，所以「保留」只表示本轮不动，不表示它已被证明有用。

经验卡的详细设计在[会话经验记忆](2026-11-11-session-experience-memory-design.md)，本文只写它在整体中的位置，以及那份草案需要修订的地方。

## 现状

AgentRecall 把本机各种编码 Agent 的会话索引到本地数据库，供人搜索、阅读和恢复。仓库里有四个部署单元：

| 单元 | 状态 | 非测试源码行数 | 说明 |
| --- | --- | --- | --- |
| V1 `agent-recall` | 稳定版 | 约 6.8 万 | SQLite，同步存储接口 |
| V2 `agent-recall-v2` | 预览版 | 约 13.6 万 | PostgreSQL，异步存储接口；其中自动化引擎约 2.7 万 |
| CLI `agentrecall` | 源码预览，未发布 | 约 500 | 团队资产和检索的命令行入口，检索依赖 V2 本地服务 |
| `workspace-core` | 内部包 | 约 3,700 | 团队配置、Git 资产、安装归属 |

V2 现在有九个页面：

| 分组 | 页面 | 作用 | 规格 |
| --- | --- | --- | --- |
| 工作区 | 工作台 | 今日用量、订阅额度、进行中的会话 | — |
| 工作区 | Session | 搜索、阅读、Resume、迁移、导出 | [session-indexing](../spec/session-indexing.md) |
| 自动化 | Eval | 按 Skill 评估 Agent 表现，回归对比 | [evaluation](../spec/evaluation.md) |
| 自动化 | Runtime | 配置执行后端和 Agent，供 Eval、Skill 探索调用 | [runtime](../spec/runtime.md) |
| 资源 | MCP | 管理 Gateway 的工具来源和开关 | [mcp](../spec/mcp.md) |
| 资源 | Memory | 按目录的长期记忆，基于 OpenViking | [memory](../spec/memory.md) |
| 资源 | Skills | Skill 库、安装到各客户端、用量 | [skills](../spec/skills.md) |
| 资源 | Provider | 服务商配置 | [providers](../spec/providers.md) |
| 协作 | 团队空间 | 通过 GitHub 仓库共享 Skills、文档、角色、会话 | [team-assets](../spec/team-assets.md) |

已经移除的：Agent Team 引擎（[ADR 0013](../adr/0013-remove-agent-team-engine.md)）和 Workflow（[ADR 0021](../adr/0021-remove-v2-workflow.md)）。

## 问题

1. **会话索引是所有功能的基础，但给 Agent 用的出口最弱。** Agent 通过 MCP 的 `search_sessions` 查历史时，多个词必须出现在同一轮才命中（[session-search-repository.ts](../../apps/main-2.0/src/core/postgres/session-search-repository.ts) 把各词条件用 `and` 拼在同一轮上），返回的也只有标题和摘要或第一句提问（[session-backend-core.ts](../../apps/main-2.0/src/main/session-backend-core.ts)），看不出命中了什么。
2. **Memory 另建了一套采集。** OpenViking 靠 Claude Code、Codex、OpenCode 的 hook 抓对话，而 AgentRecall 已经把全部来源的会话索引进了 PostgreSQL。结果是没有 hook 的来源完全没有记忆，记忆的召回也基本没有生效。数据见经验卡草案的「问题」一节。
3. **功能面宽，主线不清楚。** 九个页面里，只有 Session 和工作台直接建立在会话索引上。Workflow 删除后，Runtime 剩下的调用方是 Eval 和 Skill 探索。

## 主线

后面的取舍按一条线判断：**会话被采集 → 人能找回 → Agent 能复用 → 团队能共享**。

- 采集：会话索引，已有，覆盖全部来源。
- 人找回：Session 页、工作台，已有。
- Agent 复用：MCP Gateway 和 CLI 的检索，已有但弱；经验卡，新增。
- 团队共享：团队空间，已有。

Skills、Provider、MCP 管理是支撑这条线的资产配置。Eval 和 Runtime 是衡量和执行，本轮不扩展。

## 接下来的功能范围

| 功能 | 处理 | 说明 |
| --- | --- | --- |
| 会话索引、Session 页、Resume / 迁移 / 导出 | 保留 | 不改契约 |
| 工作台 | 保留 | — |
| 会话搜索 | 改 | 多词可跨轮命中，返回命中轮次和片段。页面、MCP、CLI 共用同一个查询 |
| `get_session` | 改 | 可以按轮次读取命中位置附近的内容 |
| Memory | 换 | 删除 OpenViking，换成经验卡 |
| Skills、Provider、MCP 管理 | 保留 | — |
| 团队空间 | 保留 | 个人和团队入口保持分开 |
| Eval | 保留 | 本轮不投入 |
| Runtime | 保留，扩充 ACP，开放成 subagent，补两处 | 见阶段二 |
| CLI | 保留，补命令 | 和 Gateway 开放的能力对应；是否发布见「待决定」 |
| 应用连接 | 新增 | 让 Agent 调用其他应用和 computer use，见「应用连接」 |
| V1 | 维护 | 会话相关的修复按仓库规则两版都检查 |

明确不做：

- Workflow 和多 Agent 编排（已移除，不恢复）。
- 开场自动注入记忆。经验卡只通过搜索被读到。
- 向量检索。沿用 PostgreSQL 的 `pg_trgm` 和全文索引。
- 对历史会话补提炼经验卡。历史靠搜索升级覆盖。
- 合并个人和团队的入口。

## 交付顺序

### 阶段一：检索和记忆（方向已定）

三个独立分支，按顺序合入：

1. **搜索升级。** 不用模型，对全部历史立即生效，经验卡也靠它被搜到，所以排第一。
2. **删除 OpenViking。** 先卸载已写进 Claude Code、Codex、OpenCode 的 hook，再删代码和表。旧数据目录由用户确认后删除。合入后到第 3 步之前，Memory 页只剩旧数据清理。
3. **经验卡。** 默认关闭，模型由用户选。

经验卡草案需要修订的地方：

| 项 | 草案现在的写法 | 改成 |
| --- | --- | --- |
| 卡片归属 | 挂在单个会话上，会话移除时一起删 | 挂在项目目录上；来源会话和轮次单独记录，只追加 |
| 类型 | 只有「问题 / 解法」 | 经验、决策两类 |
| 同一件事再次出现 | 首版不去重 | 提炼前先搜出项目内相似的旧卡交给模型，模型用卡片 id 指定更新哪张 |
| 合并 | 模型整张改写 | 程序按字段合并：问题不变，解法替换并保留上一版，走不通的路只追加 |
| 作废 | 直接删除 | 标记为已被取代，并指向新卡 |
| 触发 | 最新一轮停约 30 分钟 | 轮次已完成，且隔一次索引没再变化 |
| 要删的表 | 列了 3 张 | [schema.ts](../../apps/main-2.0/src/core/postgres/schema.ts) 里有 11 张 `openviking_*` 表，全部列出 |

读代码后新增的三点：

- **提炼由桌面主进程负责，不放在搜索后台。** 索引运行在独立的 Node 后台里，[生命周期规格](../spec/desktop-lifecycle.md#v2-常驻搜索后台)规定它不启动模型或自动化服务；能调用模型的 Runtime 在桌面主进程。所以提炼挂在桌面每次索引刷新完成之后，和现有的自动补摘要是同一个位置（[index.ts](../../apps/main-2.0/src/main/index.ts) 的 `runIndexSync`）。后果是桌面没开时不提炼，下次启动后从上次处理到的轮次接着做。提炼要有自己的服务来持有运行状态和退出清理，不能像补摘要那样直接写在 `index.ts` 里。
- **调用模型的入口要调整。** 草案打算复用的 `runOneShotOnRuntime`（[automation-service.ts](../../apps/main-2.0/src/main/services/automation-service.ts)）把调用记录写死为 Skill 探索，没选渠道时还会自动挑一个可用的。经验提炼需要自己的调用标记，并且必须使用用户明确选定的渠道，渠道不存在时报错而不是换一个。
- **搜索缺陷只在 V2。** V1 用整会话的全文索引，测试里有跨分块多词命中的用例（[sessions.test.ts](../../apps/main-1.0/src/core/store/sessions.test.ts)）。动手前再确认一次 V1 的 MCP 返回内容；如果确实没有同样的问题，搜索升级只改 V2。

### 阶段二：Runtime 补漏和扩充 ACP

- **增加可用的 ACP Runtime。** 现在走 ACP 的有 Hermes、OpenCode、OpenClaw 三个。它们共用一个 ACP 客户端，但每个各有一组驱动文件，Runtime 的 id 是写死的封闭列表（[runtime-catalog.ts](../../apps/main-2.0/src/automation/engine/shared/runtime-catalog.ts)），另有模型列表、预设、本机配置导入、设置表单等处按 id 分支。照这个方式每加一个要改十几个文件。改成一个通用的 ACP 驱动加一张「已知 Agent」表（每个 Agent 一条：命令名和进入 ACP 模式的参数），表写在代码里，用户不填任何东西。两个前提：
  - 通用 ACP 驱动的一次性调用也要走 ACP。现有三个的一次性调用用的是各自 CLI 的私有命令（`opencode run`、`hermes chat --query`、`openclaw agent`），不是 ACP，而 Eval、Skill 探索、经验提炼和下一条的 subagent 用的正是一次性调用。
  - 先补上工具白名单，否则每多一个 ACP Runtime 就多一个能绕过工具开关的入口。
- **把本机可用的 Agent 开放成 subagent。** 自动检测本机装了哪些 Agent，每个只有两个状态：能否调通、是否启用。启用的通过 MCP Gateway 开放，调用方的 Agent 可以把一段任务交给另一个 Agent 执行并拿回结果。AgentRecall 只做单次转交，不做编排，这是和已移除的 Agent Team、Workflow 的界线，需要在 Runtime 规格和一条新 ADR 里写明。现有七个 Runtime 都已有一次性调用，所以这一条不依赖上一条，可以先做。待定的设计点：
  - 「调通」怎么判断：现在的检测只跑 `--version`。握手加新建会话不花模型额度，但各家是否在这一步报未登录没有核对；真发一句提问最可靠，但每次检测都要花额度。
  - 无人值守时的权限：subagent 请求写文件或执行命令时没有人审批。现有 ACP 客户端在没有审批方时一律拒绝；非 ACP 的 Runtime 各自的行为没有核对。
  - 运行时长：MCP 客户端对单次工具调用有时限，长任务可能要拆成「启动」和「取结果」两个工具。
  - 防止互相调用：subagent 自己也可能配了 AgentRecall 的 MCP，需要限制转交深度。
  - 只在桌面运行时可用：调用 Runtime 的能力在桌面主进程，独立的搜索后台不能启动 Agent。
- **ACP 驱动补上工具白名单。** [runtime-mcp.ts](../../apps/main-2.0/src/automation/engine/main/hub/runtime/executor/runtime-mcp.ts) 里，Codex 和 Claude 的 MCP 配置都按白名单限制工具，`acpMcpServers` 只取了服务器配置，没有读白名单。走 ACP 的 Runtime 能调用被禁用的工具。这是缺陷，建议不等阶段一，单独修。
- **Runtime 启动的 Agent 默认带只读检索工具。** 现在它们只拿到手动绑定的 MCP，查不到历史会话和经验卡。这一条来自上一轮讨论，本次没有重新核对代码。

### 应用连接（方向已定，设计未定）

AgentRecall 向 Agent 提供调用其他应用的能力，包括 computer use。它和 subagent 用同一套流程：检测本机现成的 → 判断能否调通 → 用户启用 → 通过 MCP Gateway 和 CLI 开放。按应用提供的接口分三种情况：

| 应用的接口 | 检测方式 | 调用方式 | 现状 |
| --- | --- | --- | --- |
| 有 MCP 服务器 | 读取 Claude Code、Codex 里已配置的 MCP 服务器 | Gateway 转发 | Gateway 已能转发，但只能手动粘贴 JSON 添加 |
| 有命令行工具 | 已知工具表加本机命令检测 | Agent 自己在终端执行，AgentRecall 提供对应的 Skill | Skill 库已有，没有和命令检测关联 |
| 没有接口 | — | 接入一个外部的 computer use 工具源 | 没有，未调研 |

CLI 保留，并补上和 Gateway 对应的命令（工具列表与调用、subagent 列表与调用），让接不了 MCP 的调用方也能用。

待定的设计点：

- 客户端配置里的 MCP 服务器常带明文密钥，而 Gateway 现在的规则是只引用环境变量名、不保存密钥。检测到的服务器是每次启动时读客户端配置，还是要求用户改成环境变量，需要决定。
- 启用一个应用连接后，所有接入 Gateway 的 Agent 都能在该应用里执行操作。默认关闭，沿用现有的来源开关和单工具开关。
- computer use 用哪个实现、需要哪些系统权限，没有调研。

### 阶段三：候选，不排期

- 经验卡共享给团队。可以走团队空间已有的文档或运行成果，不新建通道。
- 本机和团队的聚合搜索。当前规格明确未提供。
- 发布 CLI。

## 与 teamai 的对应

之前定的方向是参考 teamai 的思路、保留自己的格式。下表只按 teamai 面板的栏目名对照，没有逐项比较功能细节。

| teamai 栏目 | AgentRecall 对应 | 状态 |
| --- | --- | --- |
| 会话 | Session | 已有 |
| Token 与费用 | 工作台 | 已有 |
| 工作流运行 | — | 已移除，不做 |
| 评分器、基准测试 | Eval | 已有 |
| 分发 | 团队空间的 Pull | 已有 |
| 知识库、资源 | 团队空间的文档，`search_resources` | 已有 |
| 改进中心、自我改进 | 经验卡 | 阶段一新增 |

## 待决定

1. 经验卡的触发：按「轮次完成」，还是保留 30 分钟静默。建议前者。
2. 偏好类卡片：首版不做，还是做并同时加开场注入。建议不做，因为不注入时 Agent 不会主动去搜偏好。
3. 来源会话被移除后：卡片保留到最后一个来源消失，还是有来源被移除就删。建议前者。
4. ACP 白名单是否提前单独修；Runtime 启动的 Agent 是否默认带只读检索工具。
5. Subagent：调用方是不是外部编码 Agent（经 MCP Gateway）；检测到的 Agent 默认启用还是默认关闭；无人值守时写文件和执行命令是拒绝还是放行；已知 Agent 表首批放哪几个；和阶段一谁先做。
6. Eval 本轮不投入是否符合预期。
7. CLI 是否发布，何时发布。

## 文档影响

阶段一合入时需要同步：[memory 规格](../spec/memory.md)整篇重写；[knowledge-search](../spec/knowledge-search.md) 和 [mcp](../spec/mcp.md) 更新搜索和读取的返回内容；[architecture](../spec/architecture.md) 里目录 Memory 的权威来源一行；新增一条替代 [ADR 0006](../adr/0006-directory-memory-opt-in.md) 的记录；README 的 V2 功能表。每个分支各带一份发布说明。
