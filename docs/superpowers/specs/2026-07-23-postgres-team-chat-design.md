# AgentRecall PostgreSQL 多 Agent Chat 设计

## 背景

AgentRecall 已能配置 Runtime、Agent、MCP、Workflow 和 Evaluation，但这些能力主要以单次执行或批处理编排的方式存在。用户希望增加一个类似 Raft 的一级 Chat 页面：在一个持久房间里选择多个现有 Agent，让用户与它们共同对话，并在应用重启后继续查看完整记录。

本次按单用户桌面应用设计。AgentRecall 是唯一执行者，PostgreSQL 负责保存房间、成员、消息和调度状态；不引入账号、组织、权限或多人在线协作。

## 目标

- 新增一级 `Chat` 页面，支持创建、切换和归档多 Agent 房间。
- 房间从现有 Runtime 配置中选择一个或多个 Agent，并绑定可选工作目录。
- 用户可用 `@Agent 名称` 指定回答者；没有 @ 时，由房间内全部启用的 Agent 回答。
- Agent 回复中可以 @ 另一名房间 Agent，把任务继续传递下去。
- PostgreSQL 持久保存房间、成员、最终消息和每次 Agent 调度状态。
- Agent 回复实时流式显示；单个 Agent 失败不阻断其他 Agent 的回答。
- 明确限制单轮 Agent 跳数和每名 Agent 的执行次数，避免自由聊天无限循环。
- 本地数据库启动失败或外部 PostgreSQL 不可连接时，页面提供清楚的重试、切换和错误提示，不影响应用其他页面。

## 不包含的范围

- 不增加注册、登录、团队、角色权限、邀请或远程协作。
- 不让多个 AgentRecall 实例竞争消费同一个房间任务。
- 不实现跨设备实时推送、消息已读、通知、文件附件或语音。
- 不复制 Raft 的 Agent 托管平台、公共桥接或 Agent 在线状态协议。
- 不保存每个流式 token；数据库只保存稳定的最终消息和调度结果。
- 不为 Chat 单独增加 Provider、模型或凭据配置。

## 产品交互

Chat 页面采用三段式工作区：

```text
房间列表           对话区                         成员
┌──────────┐      ┌────────────────────────┐    ┌──────────┐
│ + 新建    │      │ 消息、执行状态、错误提示  │    │ Agent A  │
│ 房间 A    │      │                        │    │ Agent B  │
│ 房间 B    │      │                        │    │ ...      │
└──────────┘      │ @Agent 输入消息         │    └──────────┘
                  └────────────────────────┘
```

首次进入默认使用 AgentRecall 自管的本地 PostgreSQL 兼容数据库，无需安装 PostgreSQL 或填写连接地址。数据库随 Automation 服务启动，在 Electron `userData` 下持久化，并在应用退出时关闭。创建房间使用弹窗选择名称、工作目录和 Agent。房间成员快照保存显示名与 Runtime 信息，历史消息不会因后续重命名 Agent 而失去来源。

页面仍提供低频的“外部 PostgreSQL”入口。用户可以填写连接地址切换到外部数据库，也可以随时切回本地数据库。Renderer 只能请求“使用本地数据库”，不能指定或读取本地数据库路径。

消息区默认加载最近 100 条，向上加载更早消息。正在生成的消息只存在于 Renderer 的临时状态；完成后由服务端返回正式消息。刷新或进程意外退出时，运行中的调度会在下次连接时标记为中断，不伪装成完成。

## 路由规则

每条用户消息开启一个 root turn：

1. 解析消息中的 `@显示名`，匹配时只调度被提及的启用成员。
2. 完全没有 @ 时，调度房间内全部启用成员；出现未知或不可用的 @ 时显示提示，不会意外广播。
3. 同一跳的多个 Agent 并行执行，彼此看不到尚未完成的回复。
4. Agent 最终回复若 @ 其他成员，则在下一跳调度这些成员。
5. 同一个 Agent 在一个 root turn 中最多执行一次。
6. 一个 root turn 最多产生 8 次 Agent 执行；达到限制时写入一条可见系统消息并结束。

这套规则让 Agent 能转交任务，但不会因为互相提及形成无限循环。路由由确定性代码解析和维护，模型不负责统计执行次数。

## 上下文与执行

每次调度复用现有 `AgentHub.askConfiguredAgent` 的 one-shot 执行链，支持当前所有 Runtime。Prompt 由以下稳定结构组成：

- 房间名称、当前成员和被调用 Agent 身份。
- 用户配置的 Agent instructions。
- 最近对话记录，按时间和发送者标注；默认截取最近 40 条且限制字符总量。
- 当前触发消息、root turn 已执行 Agent 清单和剩余执行额度。
- 要求直接回复房间，不虚构其他 Agent 的输出；如需转交，可 @ 房间成员。

首版不延续 Provider 的私有 runtime conversation ID。PostgreSQL 对话记录是跨 Runtime 的统一上下文来源，因此重启、切换 Runtime 或 Agent 后仍可继续房间。后续如需更低 token 成本，可在不改变房间数据模型的前提下增加 Provider continuation 优化。

## 数据模型

使用应用自管 schema `agent_recall`，ID 由应用生成 UUID，时间统一使用 `timestamptz`。

- `chat_rooms`：房间名称、工作目录、归档状态、创建和更新时间。
- `chat_room_agents`：房间与 configured Agent 的关联，以及显示名、Runtime 快照、排序和启用状态。
- `chat_messages`：发送者类型、Agent 来源、正文、root/source 消息、跳数、状态和时间。
- `chat_dispatches`：目标 Agent、root/source 消息、跳数、queued/running/completed/failed/interrupted 状态、错误和耗时。

外部 PostgreSQL 创建或升级表时使用 advisory lock，本地数据库通过串行连接生命周期避免重复初始化。所有列表查询都有明确排序与 limit。房间和消息不做硬删除入口；归档房间仍保留历史。

## 进程与模块边界

```text
TeamChatPage
  │ window.sessionSearch.teamChat
  ▼
typed preload API
  │ team-chat:* + Zod validation
  ▼
Electron main
  ├─ TeamChatService ── 数据库选择、路由、上下文、执行生命周期
  │    ├─ PGliteTeamChatStore ── 默认自管本地数据库
  │    ├─ PostgresTeamChatStore ── 可选外部 pg.Pool
  │    └─ NativeAutomationService.askConfiguredAgent
  └─ Settings ── PostgreSQL connection URL
```

Renderer 不直接访问 PostgreSQL、Node 进程或 Runtime 凭据。`PostgresTeamChatStore` 只负责 SQL 与迁移，`TeamChatService` 负责单轮状态机和 Agent 执行。消息流通过独立事件通道发送，不塞入 Automation 的全量 `AppSnapshot`。

## IPC

独立使用 `team-chat:*` 通道：

- `connection:get-status`、`connection:connect`、`connection:use-local`、`connection:disconnect`
- `rooms:list`、`rooms:create`、`rooms:update`、`rooms:archive`
- `messages:list`、`messages:send`、`turns:stop`
- `events`：dispatch started/delta/completed/failed 与持久消息通知

所有 invoke 输入在主进程使用 Zod 校验。消息长度、房间名、成员数量、分页 limit 和工作目录长度均设上限。错误响应只返回用户可操作的信息，不包含连接串、密码、环境变量或内部堆栈。

## 设置与安全

单用户设置仅保存可选的外部 PostgreSQL URL；空字符串表示使用自管本地数据库。连接 URL 只交给 Electron main 的连接池；页面保存后只显示已配置状态与脱敏地址，不在日志、消息、错误或发布说明中输出完整 URL。切换数据库时先中止正在运行的 Chat 调度并关闭旧实例，再初始化新库。

本地实现使用 PGlite 的 Node 文件系统持久化能力。它在应用进程内运行，不监听端口，也不接受外部连接；数据库目录固定由主进程根据 `userData` 计算。首次初始化、并发初始化和关闭均由 `TeamChatService` 串行管理，避免重复打开同一数据目录。

应用退出时关闭连接池并中止当前 Chat 调度。主动停止某个 turn 时通过 `AbortController` 取消仍在运行的 Agent，并把调度标记为 interrupted。

## 失败处理

- 本地数据库初始化失败：Chat 页面显示可重试错误和外部 PostgreSQL 入口，其他页面可正常使用。
- 外部 PostgreSQL 连接失败：保留当前配置入口，并允许直接切回本地数据库。
- Agent 配置已删除：房间保留成员快照，该成员显示“配置不可用”，发送时跳过并给出系统提示。
- 单个 Agent 失败：保存 failed dispatch 和可见错误消息，其余并行 Agent 继续完成。
- App 异常退出：下次初始化将旧的 running dispatch 标记为 interrupted。
- 流事件丢失：重新加载消息可恢复数据库中的最终状态；临时 delta 不作为事实来源。

## 测试与兼容性

- 路由和单轮状态机使用假的 Store 与 Agent 执行器单测，不启动真实模型。
- PostgreSQL Store 默认不连接开发者数据库；外部数据库逻辑使用假连接池测试。
- PGlite Store 测试必须使用临时目录，验证关闭后重新打开仍能读取房间和消息，并在测试后清理。
- IPC 测试覆盖通道、输入上限、事件订阅与错误脱敏。
- preload 测试覆盖每个方法映射与 unsubscribe。
- UI 合同测试覆盖一级 Chat 导航、未配置状态、房间列表、成员选择和消息发送。
- Windows 与 macOS 工作目录只作为字符串传递，不用 POSIX 命令推导路径。
- TypeScript、Vitest、构建和 release note 检查全部通过后再交付。
