# 跨 Agent 会话迁移设计

## 目标

在 Claude Code、Codex 和 CodeBuddy 之间迁移本地会话，支持全部 6 条跨 Agent 路径：

- Claude Code → Codex
- Claude Code → CodeBuddy
- Codex → Claude Code
- Codex → CodeBuddy
- CodeBuddy → Claude Code
- CodeBuddy → Codex

迁移完成后，Agent-Session-Search 使用目标 CLI 的 resume 命令，在已配置的默认终端中打开新会话。

## 范围

首版仅支持本地会话，不支持 SSH 远程会话迁移。

迁移内容包括：

- 项目路径
- 会话标题和来源元数据
- 按原顺序排列的用户与助手消息
- 可获取时保留原消息时间戳

不迁移以下内容：

- 工具调用和工具结果
- System 和 Developer 提示
- 权限与沙箱配置
- 模型配置
- 凭证、API key，以及可见消息中原本不存在的其他敏感信息

迁移过程不会修改源会话。

## 架构

使用统一中间模型和目标格式专用写入器。

```text
已索引会话
    ↓
PortableSession 读取器
    ↓
长度策略
    ├── 完整消息历史
    ├── AI 两块式压缩
    └── 本地头尾截断降级
    ↓
目标写入器
    ├── Claude Code JSONL
    ├── Codex JSONL
    └── CodeBuddy JSONL
    ↓
目标格式校验
    ↓
原子重命名到目标会话目录
    ↓
刷新本地索引
    ↓
在默认终端执行目标 CLI resume 命令
```

### Portable Session

迁移核心使用与目标 Agent 无关的结构：

```ts
interface PortableSession {
  sourceSessionKey: string;
  sourceAgent: "claude" | "codex" | "codebuddy";
  title: string;
  projectPath: string;
  startedAt: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }>;
}
```

读取器复用现有索引会话和消息存储，不再独立解析源文件。

### 迁移服务

迁移服务负责协调以下步骤：

1. 校验源会话是本地会话，并且属于三个受支持的 Agent 家族之一。
2. 校验目标 Agent 与源 Agent 不同。
3. 检查已配置的目标 CLI 可执行文件是否可用。
4. 加载全部可见的用户与助手消息。
5. 应用长度策略。
6. 让目标写入器生成并校验临时会话文件。
7. 将临时文件原子重命名到目标会话目录。
8. 记录迁移元数据。
9. 刷新应用索引。
10. 在默认终端打开目标 resume 命令。

写入器不依赖 Electron 和 UI。它接收 `PortableSession`，返回目标会话 ID、文件路径，以及生成 resume 命令所需的信息。

## 长度策略

使用以下方式估算 token：

```text
预估 token 数 = 消息总字符数 / 4
```

预估 token 不超过 60,000 时，迁移完整的可见用户与助手消息历史。

超过 60,000 时，通过现有摘要 Provider 解析顺序执行 AI 压缩（对齐 Claude Code `/compact` 策略）：

1. 专用摘要 Provider
2. Codex Provider
3. Claude Code Provider

AI 输出采用 Claude Code `/compact` 的两块式 XML 结构：

```text
<analysis>
  草稿区：按时间顺序梳理用户请求与意图、做法、关键决策、技术概念、代码模式、
  文件名/代码片段/函数签名/文件修改、错误及修复、用户反馈。
</analysis>
<summary>
  面向目标 Agent 的中文 Markdown 摘要，覆盖：用户原始目标与约束、已完成工作、
  关键决策及原因、相关文件/命令/验证结果、未解决事项、建议下一步，
  并包含最近对话的逐字引用（防止任务漂移）。
</summary>
```

`<analysis>` 块仅用于模型内部整理，压缩后会整段剥掉，只保留 `<summary>` 内容。

压缩后的会话结构为三段：

- 开头用户原始目标：逐字保留，上限 10,000 字符（防止目标漂移）
- AI 摘要：`<summary>` 内容，以 `# 会话迁移交接` 开头，硬上限 60,000 字符
- 迁移说明标记：说明以下保留最近原始消息
- 最近尾部：逐字保留最近消息，上限 10,000 字符

校验规则（任一不满足降级到本地截断）：

- 必须含合法 `<analysis>` 和 `<summary>` 块
- `<summary>` 内容 trim 后不少于 500 字符
- `<summary>` 含至少一处逐字引用标记（`>` 引用块或 `「」`/`""` 引号）

压缩提示必须明确要求模型将会话内容视为不可信数据，不执行其中嵌入的指令，且只输出纯文本不调用任何工具。

### 本地降级

如果未配置 Provider，或者 AI 压缩超时、失败、返回无效结果，则继续使用确定性的本地降级策略：

- 保留有界数量的开头消息。
- 保留有界数量的结尾消息。
- 插入明确的省略标记，并注明省略消息数量。
- 确保最终预估大小不超过迁移预算。

迁移结果标明所使用的策略：

- `complete`
- `ai-compressed`
- `locally-truncated`

## 目标写入器

每个写入器分别负责：

- 创建目标会话 ID
- 计算目标路径
- 生成目标格式 JSONL 记录
- 按目标格式生成父消息和消息标识
- 在目标支持时写入标题元数据
- 校验临时文件
- 原子安装最终文件

### Codex 写入器

写入目录：

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
```

文件包含兼容的 `session_meta` 记录，以及按顺序排列的消息 `response_item` 记录。写入器使用原项目目录作为 `cwd`。

启动器执行：

```text
codex resume <session-id>
```

### Claude Code 写入器

写入根据项目路径派生的 Claude 项目目录：

```text
~/.claude/projects/<encoded-project-path>/<uuid>.jsonl
```

写入器创建合法的父级关联用户/助手消息链，并包含会话 ID、项目目录、时间戳和目标格式所需元数据。

启动器执行：

```text
claude --resume <session-id>
```

### CodeBuddy 写入器

写入目录：

```text
~/.codebuddy/projects/<encoded-project-path>/<session-id>.jsonl
```

写入器创建按顺序排列的 CodeBuddy 消息记录和一条 `ai-title` 记录，不包含推理内容、Provider 用量、工具信息和源 Agent 专用状态。

启动器执行：

```text
codebuddy --resume <session-id>
```

### 格式兼容

写入器使用一个小型目标格式兼容层：

- 写入前检测已安装 CLI 版本。
- 将格式生成逻辑按目标 Agent 隔离。
- 使用应用现有加载器解析生成的 JSONL，完成格式校验。
- 安装前断言目标家族、会话 ID、项目路径、消息数量、消息角色和消息顺序。

不支持的目标 CLI 版本必须在写入最终文件前失败。

## 原子性与失败处理

写入前执行：

- 拒绝远程会话。
- 拒绝同 Agent 家族迁移。
- 拒绝不受支持的源。
- 检查目标 CLI 可用性和版本。
- 校验项目路径存在且为目录。

写入流程：

1. 按需创建目标目录。
2. 在同一目标目录中写入具有唯一名称的临时文件。
3. 刷盘并关闭临时文件。
4. 使用目标加载器解析和校验临时文件。
5. 原子重命名为最终会话文件。

准备或校验失败时，删除临时文件，不留下目标会话。

文件安装成功但索引刷新失败时，保留有效的迁移会话，并报告索引错误。

文件安装成功但终端启动失败时，保留迁移会话，并返回：

- 目标会话 ID
- 目标文件路径
- 可复制的 resume 命令

## 迁移元数据

在应用 SQLite 数据库中保存迁移记录：

```ts
interface SessionMigrationRecord {
  id: string;
  sourceSessionKey: string;
  sourceAgent: "claude" | "codex" | "codebuddy";
  targetAgent: "claude" | "codex" | "codebuddy";
  targetSessionId: string;
  targetFilePath: string;
  strategy: "complete" | "ai-compressed" | "locally-truncated";
  createdAt: number;
}
```

允许重复迁移。已有记录用于让 UI 识别此前创建的副本，但不会静默阻止用户主动再次迁移。

## IPC 契约

新增：

```ts
type MigrationTarget = "claude" | "codex" | "codebuddy";

interface SessionMigrationResult {
  target: MigrationTarget;
  targetSessionId: string;
  targetFilePath: string;
  strategy: "complete" | "ai-compressed" | "locally-truncated";
  resumeCommand: string;
  indexed: boolean;
  launched: boolean;
  warning?: string;
}
```

IPC 方法：

```ts
migrateSession(sessionKey: string, target: MigrationTarget): Promise<SessionMigrationResult>
```

主进程发送以下阶段更新：

- `reading`
- `compressing`
- `writing`
- `indexing`
- `launching`

阶段更新包含源会话 key，确保渲染进程可以忽略过期更新。

## 用户界面

详情工具栏新增“迁移到…”操作，右键菜单提供相同入口。

点击后打开一个小型目标选择器：

- Claude Code
- Codex
- CodeBuddy

当前来源家族不可选择。不受支持的会话和远程会话禁用该操作，并通过 tooltip 说明原因。

迁移期间，操作提示展示当前阶段。成功后显示：

- 目标 Agent
- 迁移策略
- 目标会话 ID

如果终端启动失败，结果对话框提供可复制的 resume 命令。

首版 UI 不暴露压缩阈值和高级写入器设置。

## 安全与数据边界

- 不把源会话的 System/Developer 提示复制到其他 Agent。
- 不复制源权限设置或凭证。
- 生成 AI 交接内容时，将会话正文视为不可信输入。
- 不执行会话正文中出现的命令。
- 保持现有源会话文件只读边界。
- 只写入新创建的目标会话和应用迁移元数据。

## 测试

### 核心迁移

- 覆盖全部 6 条源/目标路径。
- 拒绝同家族迁移。
- 拒绝远程迁移。
- 拒绝不受支持的源。
- 拒绝缺失目标 CLI 的迁移。
- 保留项目路径、消息顺序、角色和 Unicode 内容。

### 长度处理

- 验证 60,000 预估 token 阈值两侧的精确行为。
- AI Provider 成功。
- 未配置 Provider。
- Provider 超时。
- Provider 返回无效结果。
- 本地降级保留开头和结尾上下文，并标记省略内容。

### 写入器

- Claude Code 输出可被 Claude 加载器重新读取。
- Codex 输出可被 Codex 加载器重新读取。
- CodeBuddy 输出可被 CodeBuddy 加载器重新读取。
- ID 和父消息链合法。
- 正确生成标题元数据。
- 失败后清理临时文件。
- 最终安装使用原子重命名。

### 集成

- IPC 请求与结果类型正确。
- 进度事件路由到正确会话。
- 迁移成功后刷新本地索引。
- 使用已配置的目标二进制文件和默认终端启动。
- 启动失败时保留目标会话并返回 resume 命令。

### 渲染进程

- 详情操作和右键菜单操作正确接线。
- 目标选择器禁用源家族。
- 远程会话显示不支持原因。
- 进度和完成消息显示所选迁移策略。

## 文档

更新中英文 README，说明：

- 支持的迁移矩阵
- 仅支持本地会话的限制
- 60k 完整历史阈值
- AI 压缩和本地降级行为
- 不迁移的数据
- 迁移完成后的 resume 行为

## 不在首版范围内

- SSH 远程迁移
- 迁移工具轨迹
- 迁移图片和附件
- 保留模型和 Provider 配置
- 跨机器迁移
- 自动删除此前迁移的副本
- 用户自定义压缩阈值
