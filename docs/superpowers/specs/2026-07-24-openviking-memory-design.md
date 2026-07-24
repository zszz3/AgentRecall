# OpenViking 目录级长期记忆设计

## 背景

AgentRecall 当前的 Memory 页面用于扫描、编辑和同步 `AGENTS.md`、`CLAUDE.md` 与 Cursor Rules。该页面将被 OpenViking 驱动的长期记忆功能整体替换。新的 Memory 功能从选定目录的历史和实时 Agent 会话中提取长期记忆，在后续 Claude Code、Codex 会话中自动召回，并提供可视化管理能力。

OpenViking Memory 默认关闭。用户必须在设置中主动安装可选运行组件、配置模型并添加受管理目录。未加入白名单的目录不得触发召回、捕获、上传或索引。

## 目标

- 用 OpenViking 替换现有 Memory 页面的规则文件编辑体验。
- 以目录为单位启用和隔离长期记忆。
- 支持导入已有会话，并持续捕获启用后的新会话。
- 通过 Claude Code、Codex 生命周期 Hook 自动召回和沉淀记忆。
- 在本机托管 OpenViking，用户不需要安装或配置系统 Python。
- OpenViking 故障不得阻塞 Agent 的正常工作。
- 保留 AgentRecall 原始会话数据，避免把 OpenViking 变成唯一不可恢复的数据源。

## 非目标

- 不在首版提供跨目录全局记忆。
- 不把 OpenViking Resources、Skills、Studio 或 VikingBot 搬进 AgentRecall。
- 不把完整 AgentRecall 数据库迁移到 OpenViking。
- 不把现有 Qoder/Codex Memories 跨设备同步功能自动纳入本次删除范围。
- 不提供多个内置本地 Embedding 模型。
- 不修改或紧密链接 OpenViking Server 源码。

## 总体架构

AgentRecall 使用本机 HTTP Sidecar 模式运行官方、未修改的 OpenViking Server，并通过 Apache-2.0 的 `@openviking/sdk` 调用其 API。

```text
Claude Code / Codex Hooks
           │
           │ recall / capture / commit
           ▼
OpenViking Server ─────── @openviking/sdk ─────── AgentRecall
     Python Sidecar                                  Electron
           │
           ├── sessions and extracted memories
           └── local vector index

AgentRecall PostgreSQL
           └── complete original sessions and import checkpoints
```

OpenViking 与 AgentRecall 是独立进程，通过 loopback HTTP 通信。AgentRecall 管理 Sidecar 的安装、配置、启动、健康检查、升级与停止，但不代理或重新发送用户 Prompt。

### 数据事实源

- AgentRecall PostgreSQL 是完整原始会话的事实源。
- OpenViking 是长期记忆正文、记忆变更、会话归档和召回索引的事实源。
- 历史导入只向 OpenViking 提交适合记忆抽取的规范化会话内容。
- OpenViking 数据损坏时，可以从 AgentRecall 原始会话重新导入和抽取。

## 目录隔离模型

所有目录共享一个本地 OpenViking account：`agent-recall`。每个受管理目录映射为该 account 下的独立 OpenViking user。

```text
account: agent-recall
├── user: workspace_<stable-id-a>
│   ├── sessions
│   └── memories
└── user: workspace_<stable-id-b>
    ├── sessions
    └── memories
```

OpenViking 原生按 user 隔离记忆和会话。这比为每个目录创建 account 更轻量，也避免把目录伪装成 peer 或修改 OpenViking 的记忆写入路由。

### Workspace 身份

每个受管理目录拥有稳定的 `workspace_id`：

- Git 项目优先使用可跨路径保持稳定的仓库身份，并把当前路径作为可变定位信息。
- 普通目录生成并持久化 UUID。
- 目录移动后，用户可以重新定位，原 `workspace_id`、OpenViking user 和记忆保持不变。
- 两个目录不得静默合并为同一 workspace；检测到身份冲突时必须由用户确认。

首版严格按 workspace 隔离，不跨目录召回用户偏好或项目经验。

## 可选运行组件

OpenViking Runtime 不包含在 AgentRecall 的基础安装包中。用户首次开启 Memory 时，设置页安装一个版本固定、校验完整的可选组件。

组件包含：

- AgentRecall 专用 Python Runtime；
- 官方、未修改的 OpenViking Server；
- OpenViking 的 Python 依赖；
- Sidecar 启动清单、许可证和版本元数据。

组件不使用系统 Python，不修改 `PATH`，不执行全局 `pip install`。它安装在 AgentRecall 专用数据目录中，可以独立修复和卸载。

基于 OpenViking 0.4.11 的 macOS arm64 实测：

- Python 依赖归档约 236 MB；
- 独立 Python 压缩包约 25 MB；
- 可选组件下载预计约 260–320 MB；
- 解压后运行环境预计约 800–900 MB。

Windows 和 macOS 各架构必须在对应构建机上记录真实产物大小。设置页展示平台实际下载大小，不使用固定文案中的估算值。

### 生命周期

- Memory 关闭时不启动 Sidecar，不安装 Hook，不扫描目录。
- Memory 开启且组件已安装时，AgentRecall 按需启动 Sidecar。
- 应用退出时优雅停止 Sidecar，并终止其子进程。
- 组件损坏时提供“修复 OpenViking 组件”，使用同版本校验产物恢复。
- OpenViking 升级由 AgentRecall 发布清单控制，不自动追随上游最新版。
- 关闭 Memory 默认保留组件和数据；用户可以分别卸载组件或删除数据。

## 模型配置

OpenViking 需要两类模型：

- VLM/LLM：从会话中提取和更新长期记忆。
- Embedding：生成语义向量并召回相关记忆。

### VLM

设置页优先复用 AgentRecall 已配置的 Codex OAuth 或 Summary Provider。启用前必须验证所选模型符合 OpenViking 的接口和工具调用要求。凭据继续存放在 AgentRecall 的系统安全存储中，启动 Sidecar 时注入，不复制到普通日志或未保护的配置文件。

VLM 不可用时：

- 已捕获内容保留在待处理队列；
- 不产生半成品记忆；
- 恢复后可以重试；
- Agent 本身继续正常工作。

### Embedding

首版只提供 OpenViking 官方内置本地模型 `bge-small-zh-v1.5-f16`：

- 512 维；
- 通过 `llama-cpp-python` 在 CPU 上运行；
- 不要求独立显卡；
- 模型下载约 48 MB；
- 由用户明确点击“下载模型”后安装。

设置页同时允许配置 OpenViking 支持的远程 Embedding Provider，但不把远程模型伪装为本地下载项。

切换 Embedding Provider、模型、维度或模型文件后，现有向量索引失效。系统必须暂停召回并要求重建向量；长期记忆正文不需要重新抽取。

## Agent 集成

AgentRecall 为 Claude Code 和 Codex 分别提供集成开关。集成使用其原生生命周期 Hook 和 OpenViking MCP，不由 AgentRecall 截获或代发 Prompt。

### 自动召回

```text
UserPromptSubmit
  → 读取当前工作目录
  → 检查目录白名单
  → 解析 workspace_id 和 OpenViking user
  → 使用 Prompt 查询相关记忆
  → 把结果作为 additional context 返回给 Agent
```

召回内容不改变输入框中的用户文字。首版应设置保守的结果数量和 token 上限，并在 Memory 页面展示最近召回记录与来源。

### 自动捕获

```text
Stop
  → 读取本轮新增对话
  → 追加到对应 OpenViking session

PreCompact / SessionEnd
  → 补齐尚未捕获的内容
  → commit session
  → OpenViking 异步抽取长期记忆
```

Hook 触发后先检查当前目录是否在白名单中。未受管理目录立即退出，不读取或发送 Prompt。Hook 失败必须 fail-open，不得阻断 Claude Code 或 Codex。

MCP 允许 Agent 主动调用 OpenViking 的 `find`、`recall` 和 `remember` 等工具。自动召回不依赖模型主动调用 MCP。

## 历史导入与实时去重

添加目录时，AgentRecall 扫描该目录已有会话并展示：

- 会话数量；
- 时间范围；
- 来源 Agent；
- 预计处理范围。

用户确认后后台回填。启用后的新会话由 Hook 增量捕获。

历史导入转换流程：

1. 从 AgentRecall 原始会话读取消息。
2. 保留用户与助手的有效文本。
3. 过滤状态噪声、重复事件和不参与记忆的内部记录。
4. 对超大工具输出执行确定性截断或摘要表示。
5. 过滤已识别的敏感字段。
6. 转换成 OpenViking messages。
7. commit 并轮询异步任务。
8. 保存成功检查点和失败原因。

每个来源会话使用稳定来源 ID，每个 turn 使用内容 fingerprint。历史导入和实时 Hook 即使覆盖同一会话，也不得重复提交相同 turn。

导入支持暂停、继续、取消、断点续传和按会话重试。取消任务不删除已经成功生成的记忆。

## Memory 页面

### 关闭状态

Memory 未启用时展示：

- 功能说明；
- 本地数据与模型说明；
- “前往设置”入口。

不得在后台探测、下载或启动 OpenViking。

### 目录列表

启用后展示受管理目录和“添加目录”。每个目录显示：

- 名称与当前路径；
- OpenViking 健康状态；
- 已导入会话数；
- 记忆数量；
- 最近同步时间；
- 当前导入进度；
- Claude Code、Codex Hook 状态。

### 目录详情

目录详情支持：

- 语义搜索；
- 按记忆类型筛选；
- 查看记忆正文、更新时间与来源会话；
- 手动添加记忆；
- 编辑和删除单条记忆；
- 查看最近召回记录；
- 暂停或恢复历史导入；
- 重试失败会话；
- 重建向量索引。

### 停止与删除

移除目录提供两个独立操作：

- 停止管理：保留 OpenViking user 数据，停止召回、捕获和导入；重新添加可以恢复。
- 彻底删除：二次确认后删除该 workspace user 的会话、记忆和索引。

彻底删除完成后，本地只保留不含内容的操作审计信息。删除失败必须显示剩余状态并允许重试，不能先移除本地映射造成孤儿数据。

## 设置页

设置项包括：

- `启用 OpenViking Memory`，默认关闭；
- 可选组件的安装、修复和卸载；
- OpenViking 版本、服务状态和数据目录；
- VLM Provider 与健康检查；
- 本地 BGE 模型的下载、状态和删除；
- 远程 Embedding 配置；
- Claude Code 集成开关；
- Codex 集成开关；
- 组件、模型、索引和记忆数据的磁盘占用。

只有 Runtime、VLM 和 Embedding 健康检查全部通过后，用户才能添加受管理目录。

## 错误处理与恢复

- OpenViking 不可达：Hook fail-open；捕获内容进入本地持久队列。
- Sidecar 意外退出：AgentRecall 使用有上限的退避策略重启，并展示故障状态。
- 端口冲突：使用 AgentRecall 管理的 loopback 端口分配，不假定 1933 永远可用。
- Embedding 损坏或不兼容：停止召回，保留正文，提示修复模型或重建索引。
- VLM 失败：保留任务输入和错误，不写入半成品记忆。
- 目录丢失：暂停 workspace，允许重新定位，不自动删除。
- 应用强制退出：下次启动恢复未完成导入、捕获队列和异步任务轮询。
- Hook 配置损坏：显示具体 Agent 的修复入口，不影响另一个 Agent。
- 组件升级失败：继续使用上一个已验证版本，不破坏现有数据。

普通日志不得记录 API Key、完整 Prompt、完整工具输出或记忆正文。调试日志必须显式开启，并继续执行敏感字段清理。

## 安全与许可证

- Sidecar 仅监听 `127.0.0.1`。
- Root Key 随机生成并保存到系统安全存储。
- 每个 workspace user 使用独立凭据。
- 下载的 Runtime 和模型必须校验发布清单中的哈希。
- OpenViking Server 保持官方、未修改的 AGPL-3.0 组件。
- AgentRecall 保持 MIT；两者通过 HTTP 通信。
- 分发页面和应用内展示 OpenViking 版本、AGPL-3.0 许可证及对应源码地址。
- 如果未来修改 OpenViking，修改后的对应源码必须按 AGPL-3.0 提供。

## 测试策略

### 单元测试

- workspace 身份生成、路径移动和冲突处理；
- account/user 映射；
- 白名单匹配，包括 macOS、Windows 和大小写规则；
- session ID 与 turn fingerprint 去重；
- 导入检查点与重试状态机；
- 停止管理与彻底删除语义；
- Embedding 配置变化与重建判定；
- Prompt、工具输出和日志的敏感信息清理。

### 契约测试

使用假的 OpenViking HTTP Server 验证：

- 健康检查；
- user 生命周期；
- session 批量写入与 commit；
- 后台任务轮询；
- 搜索、读取、写入和删除记忆；
- 超时、鉴权失败、限流和服务异常。

### 集成测试

使用临时 HOME、临时应用数据目录、临时运行组件和合成会话：

- 安装、修复、升级和卸载可选组件；
- 启动并停止真实 OpenViking Sidecar；
- 下载或注入测试模型；
- 创建 workspace user；
- 导入合成历史会话；
- 完成一次记忆抽取和召回；
- 验证 Claude Code、Codex Hook 在白名单内生效、白名单外无请求；
- 验证进程崩溃后队列和导入断点恢复。

测试不得读取、上传、改写或删除真实用户的 Claude、Codex、Skills、Supabase、Electron、OpenViking 或会话数据。

### 打包验证

- macOS arm64、macOS x64 和 Windows x64 分别构建可选组件；
- 记录每个平台实际下载与解压大小；
- 在临时 npm prefix 和 HOME 中安装生成产物；
- 验证 CLI 与 Electron 能启动对应 Runtime；
- 测试结束后停止所有 Sidecar、Hook 和子进程；
- 清理临时数据库、模型、下载归档和运行锁。

## 发布与回滚

首版按功能开关灰度发布，默认关闭。OpenViking Runtime 与 AgentRecall 版本通过兼容矩阵绑定。

升级前记录 Runtime 版本和数据格式。升级失败时回滚到上一份已验证 Runtime；不自动降级或重写 OpenViking 数据。涉及数据迁移时必须先提供备份和恢复路径。

用户关闭功能时，Hook 立即停止生效。用户可以保留数据等待重新启用，也可以分别删除模型、Runtime 和 workspace 数据。

## 已确认的产品决策

- 现有 Memory 页面整体替换，不保留规则文件编辑 UI。
- Memory 默认关闭。
- OpenViking 作为可选组件安装，不进入基础安装包。
- 本机运行，不要求用户安装 Python。
- 首版只提供官方 BGE 本地模型。
- 本地模型使用 CPU，不要求 GPU。
- 用户主动选择受管理目录。
- 添加目录时预览并回填已有会话，新会话持续捕获。
- 单 OpenViking account、多 workspace user。
- 首版严格目录隔离，不做全局记忆。
- Claude Code、Codex 使用原生 Hook 自动召回和捕获。
- 停止管理默认保留数据，彻底删除需要二次确认。
