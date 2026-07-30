# Workflow 官方克隆与个人导入导出设计

## 文档状态

- 状态：已实现并通过实现审查
- 适用范围：`apps/main-2.0` 的 Workflow V2
- 主要读者：负责实现、审查和验证 Workflow 能力的维护者
- 内容类型：设计说明与接口参考

本文定义官方 Workflow 克隆、个人 Workflow 文件导入和个人 Workflow 文件导出的完整产品与技术契约。当前实现以本文的行为规则、信任边界和验收标准为准。

`apps/main-1.0` 当前没有 Workflow V2 合约，本设计不要求在 V1 中增加同等能力。该范围与会话功能的双应用同步规则无关。

## 要解决的问题

官方 Workflow 当前通过 `sourceType: "official"` 和 `topologyLocked: true` 保持只读。用户可以运行它，但不能把它直接变成可自由修改的个人版本。Workflow 也缺少可移植的文件契约，用户无法安全地迁移或分享个人 Workflow。

本设计提供三条明确路径：

1. 用户把应用内置的官方 Workflow 克隆为独立个人副本。
2. 用户从 AgentRecall Workflow 文件导入一个新的个人 Workflow。
3. 用户把个人 Workflow 导出为文件，用于备份、迁移或分享。

三条路径最终都围绕同一个不变量：新建的个人 Workflow 拥有新的 ID，不覆盖已有记录，不继承运行状态，并可以独立修改。

## 目标

- 让官方 Workflow 可以作为模板被用户安全复用。
- 让个人 Workflow 可以通过单文件迁移和分享。
- 保证克隆或导入不会修改原 Workflow，也不会覆盖本地同 ID Workflow。
- 保证文件中的来源声明不能伪造官方身份。
- 复用现有 Workflow V2 定义校验、脚本风险分析和运行授权机制。
- 在创建个人 Workflow 前展示文件内容、兼容性和依赖问题。
- 把可移植定义与本机运行状态、凭据、工作目录和历史数据严格分离。

## 非目标

首版不支持以下能力：

- 官方 Workflow 与个人副本之间的后续同步、更新提示或差异合并。
- 一个文件包含多个 Workflow。
- 文件夹、ZIP 或工作区级批量导入导出。
- 导出官方 Workflow。用户需要先克隆为个人 Workflow。
- 打包或安装 Agent、模型、Skill、MCP、Provider、凭据或其他外部资源。
- 通过名称自动猜测 Agent、模型或工具映射。
- 系统级文件关联或双击打开 `*.agentrecall-workflow.json`。
- 导出旧修订、运行快照、调度任务或运行历史。
- 通过文件签名把外部文件提升为官方来源。
- 在 `apps/main-1.0` 中实现 Workflow V2 导入导出。

## 当前代码事实

以下事实是设计的现有基础，不代表导入导出能力已经实现：

- `WorkflowDraftState` 当前包含身份、来源、编辑状态、执行 Agent、模型、定义、工作目录、规划消息、运行数据和时间戳。文件导出不能直接序列化整个对象。
- `WorkflowV2Definition` 包含 `workflowId`、图版本、目标、节点和边。
- LLM 节点可以直接引用 `configuredAgentId`、`modelId` 和 `requiredTools`。
- MCP 绑定属于 Agent 配置。Workflow 定义没有独立的 `mcpId` 映射字段。
- Workflow 定义没有独立的 Skill ID 引用字段。
- 脚本节点参数支持 `valueType: "secret"`，也支持 `defaultValue` 和 `literalValue`。
- 脚本节点已经具备风险、能力、权限确认和审计机制。导入不能再创建一套平行的永久信任系统。
- `WorkflowStatus` 已经包含 `draft`，但没有 `待配置` 状态。
- 官方 Workflow 通过 `sourceType: "official"` 和 `topologyLocked: true` 与个人 Workflow 分离。
- Workflow 页面已经使用 `topologyLocked` 控制定义编辑，历史面板已经按官方和个人来源分组。

主要代码入口：

- `apps/main-2.0/src/automation/engine/shared/workflow/draft.ts`
- `apps/main-2.0/src/automation/engine/shared/workflow-v2/definition.ts`
- `apps/main-2.0/src/automation/engine/shared/workflow-v2/validation.ts`
- `apps/main-2.0/src/automation/engine/shared/workflow/run.ts`
- `apps/main-2.0/src/automation/engine/main/hub/workflow/agent-hub-workflow-clone.ts`
- `apps/main-2.0/src/automation/engine/main/workflows/v2/workflow-v2-script-analysis.ts`
- `apps/main-2.0/src/automation/engine/main/workflows/v2/workflow-v2-script-input.ts`
- `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/WorkflowHistoryPanel.tsx`
- `apps/main-2.0/src/automation/engine/renderer/src/pages/workflow/WorkflowPage.tsx`
- `apps/main-2.0/src/shared/ipc/automation.ts`
- `apps/main-2.0/src/main/ipc/automation.ts`
- `apps/main-2.0/src/preload/automation.ts`
- `apps/main-2.0/src/automation/engine/renderer/src/app/services/workflow-service.ts`

## 核心术语

| 术语 | 定义 |
| --- | --- |
| 官方 Workflow | 由应用内置官方目录提供，运行时来源为 `official`，拓扑默认锁定的 Workflow。 |
| 个人 Workflow | 来源为 `user`，用户可以修改和删除的 Workflow。 |
| 克隆 | 从应用内官方 Workflow 快照创建一个全新个人 Workflow。 |
| 导入 | 从本地文件解析、预览并创建一个全新个人 Workflow。 |
| 导出 | 把个人 Workflow 的当前已保存定义写入可移植文件。 |
| 根来源 | Workflow 最初直接克隆的官方 Workflow 来源快照。 |
| 本次导入来源 | 当前个人 Workflow 直接从哪个文件和原 Workflow ID 导入。 |
| 就绪检查 | 在结构校验之外，检查当前设备是否具备运行该 Workflow 所需 Agent、模型、工具和必要输入。 |
| 定义校验 | `validateWorkflowV2Definition(...)` 对 DAG、节点、边和脚本契约执行的结构与语义校验。 |

## 不变量

实现必须始终满足以下规则：

1. 克隆和导入始终生成新的 Workflow ID。
2. 文件中的 Workflow ID 只作为来源信息，不能决定本地保存 ID。
3. 克隆和导入绝不覆盖、合并或更新已有 Workflow。
4. 所有文件导入结果都强制为个人 Workflow。
5. 文件中的 `sourceType`、官方标识或来源说明都不能提升信任等级。
6. 克隆和导入结果统一为 `status: "draft"`。
7. 新副本不继承确认修订、运行、会话、缓存、调度、授权或历史数据。
8. 官方 Workflow 继续只读，用户必须先克隆才能修改或导出。
9. 导入文件在预览与确认前不能创建数据库记录。
10. 导入过程不能执行 Workflow 节点或脚本。
11. 个人副本与原官方 Workflow 完全解耦，后续不跟随官方更新。
12. 同一个官方 Workflow 可以被多次克隆，同一个文件可以被多次导入。

## 用户流程

### 克隆官方 Workflow

1. 用户在官方 Workflow 卡片或详情页选择“克隆为个人 Workflow”。
2. 主进程读取该官方 Workflow 的当前已保存修订。
3. 系统生成新的 Workflow ID，并同步改写 definition 内的 `workflowId`。
4. 系统复制标题、目标、定义和执行默认项。
5. 系统写入不可变的官方根来源快照。
6. 系统把副本保存为 `sourceType: "user"`、`topologyLocked: false`、`status: "draft"`。
7. 系统清空所有非可移植状态。
8. 系统选择新副本并直接打开编辑页。
9. 页面显示就绪检查结果。依赖问题不会撤销已经创建的草稿。

官方克隆不需要文件导入预览，因为来源来自当前应用内的官方目录。它仍然需要通过现有定义校验和就绪检查。

### 从文件导入个人 Workflow

导入采用两阶段流程。

#### 阶段一：解析和预览

1. 用户在个人 Workflow 列表区域选择“从文件导入”。
2. 主进程打开文件选择器，只接受 `*.agentrecall-workflow.json`。
3. 主进程读取文件，并执行大小、JSON、格式标识和 schema 版本检查。
4. 系统迁移已知旧版本，然后执行 Workflow V2 定义校验。
5. 系统建立导入预览，包括名称、原 Workflow ID、原修订、节点数、边数、脚本风险、根来源、依赖问题和 Secret 清理结果。
6. 用户可以为缺失的 Agent 和模型选择本地替代项，也可以保留未解决问题。
7. 此阶段不写入 Workflow 存储。

#### 阶段二：确认创建

1. 用户确认导入。
2. 系统重新校验预览令牌或内容摘要，防止预览后文件内容发生变化。
3. 系统生成新的 Workflow ID，并改写 definition 内的 `workflowId`。
4. 系统应用用户确认的 Agent 和模型映射。
5. 系统创建个人草稿并一次性持久化。
6. 系统记录本次导入来源和可选根来源。
7. 系统选择新 Workflow 并进入编辑页。
8. 未解决的依赖通过“待配置”徽标和问题列表展示。

结构损坏、未知格式或不支持的 schema 版本会阻止进入确认阶段。依赖缺失不会阻止保存草稿，但会阻止确认或运行。

### 导出个人 Workflow

1. 用户在个人 Workflow 详情页或个人卡片菜单选择“导出文件”。
2. 如果编辑器存在未保存修改，页面要求用户先保存或取消导出。
3. 系统读取当前已保存修订，而不是运行快照或旧修订。
4. 系统构建可移植包并清理 Secret 字面值。
5. 主进程打开保存对话框，默认文件名为 `<workflow-name>.agentrecall-workflow.json`。
6. 主进程以 UTF-8 JSON 写入用户选择的位置。
7. 写入成功后提示最终路径。用户取消保存不视为错误。

运行中的 Workflow 不影响当前已保存定义的导出。导出不得读取或附带该次运行的上下文、输出或历史。

## 命名规则

- 第一次克隆或导入默认命名为 `<原名称> - 副本`。
- 同名时使用 `<原名称> - 副本 2`、`<原名称> - 副本 3`，依次递增。
- 名称冲突只影响显示名称，不影响导入是否允许。
- 系统不按标题、原 ID 或内容摘要去重。
- 导出文件名需要替换操作系统不允许的字符，但不能修改 Workflow 内部标题。

## 文件契约

### 文件名和编码

- 扩展名：`.agentrecall-workflow.json`
- 编码：UTF-8
- 首版文件粒度：一个文件只包含一个 Workflow
- 格式标识：`agentrecall.workflow`
- 首版 schema 版本：`1`
- 最大文件大小：5 MiB。超过限制时在解析 JSON 前拒绝读取。
- JSON 必须是单个对象。实现不得静默忽略根级未知字段。

5 MiB 是应用级防滥用限制，不属于 schema 语义。后续可以独立调整，但必须保持错误可识别且不得静默截断。

### 建议的 TypeScript 合约

```ts
export interface WorkflowPortableFileV1 {
  format: "agentrecall.workflow";
  schemaVersion: 1;
  workflow: {
    workflowId: string;
    revision: number;
    title: string;
    objective: string;
    executionDefaults: {
      configuredAgentId: string;
      modelId: string;
      reviewerConfiguredAgentId: string;
      reviewerModelId: string;
    };
    definition: WorkflowV2Definition;
    rootOrigin?: WorkflowOfficialOriginSnapshot;
  };
}

export interface WorkflowOfficialOriginSnapshot {
  kind: "official";
  workflowId: string;
  title: string;
  revision: number;
  clonedAt: number;
}
```

`workflow.workflowId` 必须与 `workflow.definition.workflowId` 一致。导入时两者都不能被用作新本地 ID。

文件不包含 `sourceType`。即使未来兼容旧文件读取到类似字段，导入结果仍必须强制为 `user`。

### 示例

```json
{
  "format": "agentrecall.workflow",
  "schemaVersion": 1,
  "workflow": {
    "workflowId": "wf_source_example",
    "revision": 7,
    "title": "代码变更审查 - 副本",
    "objective": "审查代码变更并输出结构化结论",
    "executionDefaults": {
      "configuredAgentId": "agent-codex-reviewer",
      "modelId": "gpt-example",
      "reviewerConfiguredAgentId": "agent-independent-reviewer",
      "reviewerModelId": "gpt-example"
    },
    "definition": {
      "workflowId": "wf_source_example",
      "graphVersion": 1,
      "objective": "审查代码变更并输出结构化结论",
      "nodes": [
        {
          "id": "review",
          "kind": "review",
          "title": "审查变更",
          "execModel": "llm",
          "executionMode": "one-shot",
          "prompt": "审查输入的代码变更并输出结构化结论。",
          "outputFields": [
            {
              "key": "report",
              "required": true
            }
          ]
        }
      ],
      "edges": []
    },
    "rootOrigin": {
      "kind": "official",
      "workflowId": "official-code-change-review",
      "title": "代码变更审查",
      "revision": 3,
      "clonedAt": 1785283200000
    }
  }
}
```

示例使用一个无边的终端 LLM 节点，展示可以通过当前 Workflow V2 基础结构校验的最小文件形态。真实文件中的 `definition` 仍必须通过完整 Workflow V2 定义校验和导入端边界校验。

## 文件包含和排除的字段

### 必须包含

| 字段 | 原因 |
| --- | --- |
| 文件格式与 schema 版本 | 支持严格解析和显式迁移。 |
| 原 Workflow ID 和修订号 | 用于预览、来源说明和问题定位。 |
| 标题与目标 | 保持用户可识别语义。 |
| 当前已保存的 Workflow V2 definition | 保存可执行拓扑和节点配置。 |
| 默认执行 Agent 与模型引用 | 保持未逐节点覆盖时的执行意图。 |
| Reviewer Agent 与模型引用 | 保持独立审查行为的执行意图。 |
| 可选根来源 | 保留“最初克隆自官方”的说明。 |

### 必须排除

| 字段或数据 | 排除原因 |
| --- | --- |
| `sourceType`、`topologyLocked` | 导入端强制建立个人可编辑副本。 |
| `status`、`confirmedRevision` | 新副本必须重新检查和确认。 |
| `workDir` | 本机路径不可移植，也可能泄露本地信息。 |
| `messages`、`reply`、`error` | 规划访谈状态不是 Workflow 定义。 |
| `contextDocument`、`runContextDocument` | 可能包含项目私有背景，且不属于拓扑定义。 |
| `runProgress`、`runIds`、`finalReport` | 运行状态和历史不属于可移植定义。 |
| `workflowV2Plan`、`generationReview` | 这些是可重新生成的派生或审查状态。 |
| `runtimeConversation` | 会话状态与当前设备和运行时绑定。 |
| `createdAt`、`updatedAt` | 新副本需要自己的生命周期时间。 |
| 调度、调度运行与 due event | 导入不能自动建立或启用定时任务。 |
| Run、节点缓存、输出、Artifact | 导入不能恢复或伪造历史执行结果。 |
| Agent、Skill、MCP、Provider 配置 | 外部资源由当前设备单独管理。 |
| API Key、Token、认证头和环境凭据 | 凭据不能通过 Workflow 文件迁移。 |
| 脚本授权与批准记录 | 新副本必须重新走现有运行授权。 |

来源快照中的 `clonedAt` 是来源事实，不是被继承的个人 Workflow 生命周期时间。

## ID 和修订规则

- 克隆或导入生成 `wf_<uuid>` 形式的新 ID，复用当前 Workflow ID 生成约定。
- 保存前必须把新 ID 同时写入 `WorkflowDraftState.workflowId` 和 `definition.workflowId`。
- 节点 ID 和边引用保持不变，因为它们属于图内部身份。
- 新个人 Workflow 的修订从 `1` 开始。
- 文件中的原修订仅作为来源元数据，不决定新修订。
- `confirmedRevision` 必须为空。
- 旧 Workflow、同 ID Workflow 和同内容 Workflow 都不能被更新。

## 来源与信任模型

### 官方身份

只有应用内置官方目录加载的 Workflow 可以拥有官方身份。

- 直接克隆官方 Workflow 时，系统从受控应用内状态建立官方根来源快照。
- 克隆结果仍是个人 Workflow，只展示“克隆自：<官方名称>”。
- 文件导入永远是个人 Workflow。
- 文件中的 `rootOrigin` 只用于说明，不用于认证。
- 即使文件声称最初来自官方，也不能继承应用内官方可信来源。
- 官方 Workflow 后续改名或移除时，个人副本仍显示保存的来源快照。
- 如果当前官方 Workflow 仍存在，UI 可以链接到它；不存在时只显示历史文本。

### 两层来源信息

个人 Workflow 最多保留两层来源，避免形成无限转手链：

```ts
export interface WorkflowOriginMetadata {
  importedFrom?: {
    fileName: string;
    workflowId: string;
    title: string;
    revision: number;
    importedAt: number;
  };
  rootOrigin?: WorkflowOfficialOriginSnapshot & {
    trust: "catalog" | "file_claim";
  };
}
```

- `importedFrom` 描述本次直接导入来源，由导入端根据文件和预览结果建立。
- `rootOrigin` 描述最初的官方来源。直接从应用内官方目录克隆时写入 `trust: "catalog"`；从文件恢复同一说明时强制降为 `trust: "file_claim"`。
- 可移植文件不携带可继承的 `trust`。导出时只写来源快照字段，导入时无条件按 `file_claim` 持久化。
- 再次导出时不携带此前的 `importedFrom` 链。下一位导入者会把当前文件的 Workflow 身份记录为新的 `importedFrom`。
- 两类来源都不能改变 `sourceType` 或运行权限。

建议把 `origin?: WorkflowOriginMetadata` 作为 `WorkflowDraftState` 的可选持久化字段，并在 PostgreSQL Workflow repository 中持久化。不要把来源只放在 renderer 临时状态中。

## Secret 处理

Provider API Key、MCP 凭据和 Agent 认证配置不属于 Workflow 可移植文件，也不应由导出器读取。

当前 Workflow V2 脚本参数支持 `valueType: "secret"`，且参数可能通过 `defaultValue` 或 `literalValue` 保存字符串。导出器和导入器必须复用同一个纯函数，对 definition 执行以下定向清理：

1. 遍历所有脚本节点参数。
2. 当 `valueType !== "secret"` 时保持参数不变。
3. 当 `valueType === "secret"` 时移除 `defaultValue` 和 `literalValue`。
4. 保留参数 key、label、location、source、required 和描述，使导入者知道需要重新配置什么。
5. 在导出成功提示中说明清理了多少个 Secret 值。

导出端清理用于避免 AgentRecall 生成的文件携带 Secret。导入端必须再次清理，不能假设文件一定由 AgentRecall 正常导出。手工构造、旧版本或被修改的文件即使包含 Secret 字面值，也不能把这些值持久化到新的个人 Workflow。导入预览需要展示本次清理数量。

首版不扫描普通提示词或脚本文本中的疑似 Token。通用文本扫描误报高，也无法提供可靠保证。产品文案不得声称导出器可以发现所有手工硬编码的秘密。

如果 Secret 参数的来源是 `literal`，清理后就绪检查必须把该参数标记为待配置。来源为 `user` 且设计为运行时输入的 Secret 不应仅因当前没有值而阻止保存草稿。

## 脚本安全模型

文件导入不创建独立的“信任文件”或“永久启用脚本”状态。

- 导入预览展示脚本节点、声明能力、静态分析风险和不确定项。
- 导入过程不执行脚本。
- 导出文件不包含运行批准或授权记录。
- 新 Workflow 没有 Run 和授权历史，因此首次运行自然进入现有脚本治理流程。
- 直接克隆官方 Workflow 只代表来源可信，不能绕过危险脚本操作的现有授权。
- 文件中的 `managerRisk` 和能力声明仍需通过现有静态分析与治理逻辑检查，不能把作者声明当作最终风险结论。

## 依赖解析与就绪检查

### 实际依赖范围

首版只处理当前 Workflow 合约真实表达的依赖：

- Workflow 默认 `configuredAgentId` 和 `modelId`
- Workflow 默认 Reviewer Agent 和模型
- LLM 节点级 `configuredAgentId` 和 `modelId`
- LLM 节点的 `requiredTools`
- 被清理后无法解析的 Secret 参数

Workflow 文件不包含独立 Skill 或 MCP ID，因此不设计 Skill/MCP 映射界面。MCP 和 Skill 能力通过当前设备上的 Agent 与工具可用性间接体现。

### 自动匹配

- 只有稳定 ID 完全一致时才自动匹配 Agent。
- 模型必须在匹配后的 Agent 或其 Channel 上可用，才算匹配成功。
- `requiredTools` 必须按运行时真实可用工具标识检查。
- 系统不能因显示名称相同而静默映射。
- 缺失项可以由用户显式选择替代 Agent 或模型。
- 工具缺失只展示问题和修复方向，首版不导入或安装 MCP、Skill。

### 就绪检查结果

`待配置` 是派生显示，不是新的 `WorkflowStatus`。

```ts
export interface WorkflowReadinessResult {
  ready: boolean;
  issues: WorkflowReadinessIssue[];
}

export interface WorkflowReadinessIssue {
  code:
    | "AGENT_MISSING"
    | "MODEL_UNAVAILABLE"
    | "REQUIRED_TOOL_MISSING"
    | "SECRET_VALUE_REQUIRED";
  scope: "workflow" | "reviewer" | "node";
  nodeId?: string;
  field: string;
  message: string;
}
```

就绪结果由当前 Workflow 与当前设备配置实时计算，不持久化布尔状态。配置变化后结果自动更新。

### 对确认和运行的影响

- 定义校验失败时不能确认或运行。
- 就绪检查失败时不能确认或运行。
- 用户仍可以保存、选择、重命名、编辑、导出或删除未就绪草稿。
- 所有问题解决后“待配置”徽标自动消失。
- 修复依赖并修改 definition 后继续沿用现有修订和确认语义。

## schema 版本和迁移

导入器必须严格处理 schema 版本：

| 输入 | 行为 |
| --- | --- |
| `schemaVersion: 1` | 直接解析和校验。 |
| 已知旧版本 | 通过纯函数逐版本迁移到当前版本，预览中显示升级提示。 |
| 高于应用支持的版本 | 拒绝导入，提示用户升级 AgentRecall。 |
| 缺少版本 | 拒绝导入，不猜测字段含义。 |
| 未知版本 | 拒绝导入。 |

导出器始终输出当前 schema 版本。迁移函数必须：

- 不访问用户真实 HOME、凭据、网络或运行数据。
- 不创建 Workflow 记录。
- 对同一输入产生确定结果。
- 保留来源 Workflow ID 和用户可见内容。
- 在迁移后再次执行严格 schema 校验和 Workflow V2 定义校验。

`schemaVersion` 与 definition 内的 `graphVersion` 是两个独立概念。前者描述文件外壳，后者描述 Workflow 图定义版本。

## 预览模型

建议使用只存在于内存中的预览结果：

```ts
export interface WorkflowImportPreview {
  previewToken: string;
  contentDigest: string;
  fileName: string;
  sourceWorkflowId: string;
  sourceRevision: number;
  title: string;
  objective: string;
  schemaVersion: number;
  migratedFromSchemaVersion?: number;
  nodeCount: number;
  edgeCount: number;
  scripts: Array<{
    nodeId: string;
    title: string;
    effectiveRisk: WorkflowV2ScriptRiskLevel;
    capabilities: WorkflowV2ScriptCapability[];
    uncertain: boolean;
  }>;
  removedSecretValueCount: number;
  rootOrigin?: WorkflowOfficialOriginSnapshot;
  definitionErrors: string[];
  definitionWarnings: string[];
  readiness: WorkflowReadinessResult;
}
```

预览令牌只在当前应用进程和短时间窗口内有效。确认导入必须提交令牌和用户选择的显式映射。主进程需要校验内容摘要，不能相信 renderer 回传的 definition。

## 原子性与并发

- 预览阶段零持久化。
- 确认导入在主进程内生成新 ID、应用映射并再次校验。
- 新 Workflow 作为一个完整记录一次性写入 repository。
- 持久化失败时不能留下半成品 Workflow、来源记录或 active Workflow 指针。
- 成功保存 Workflow 后才切换 `activeWorkflowId`。
- 用户重复点击确认时，预览令牌只能成功消费一次，防止创建非预期重复副本。
- 用户主动再次发起导入或克隆仍然允许创建多个副本。
- 导出先写入同目录临时文件，再以原子替换完成最终文件，避免留下半写 JSON。若目标已存在，覆盖必须由系统保存对话框明确确认。

## UI 设计

### Workflow 历史面板

在 `WorkflowHistoryPanel` 中增加：

- 个人 Workflow 分组标题附近的“从文件导入”按钮。
- 每个官方 Workflow 卡片上的“克隆为个人 Workflow”动作。
- 个人 Workflow 右键菜单中的“导出文件”动作。
- 个人 Workflow 卡片上的可选“待配置”徽标。

官方 Workflow 仍然不能重命名、删除或打开个人 Workflow 的编辑菜单。

### Workflow 详情页

个人 Workflow 详情页增加：

- “导出文件”按钮。
- 来源说明。直接克隆显示经过应用目录确认的官方来源；文件导入显示本次文件来源，并可附带“文件声明的根官方来源”。
- 就绪问题列表和修复入口。
- 未就绪时禁用确认与运行，并展示具体原因。

官方 Workflow 详情页增加“克隆为个人 Workflow”，不增加“编辑”或“导出”按钮。

### 导入预览对话框

预览对话框至少展示：

- 文件名、标题、原 ID、原修订和 schema 版本。
- 节点数、边数和 definition 校验结果。
- 是否发生旧版本迁移。
- 脚本节点、风险、能力和不确定分析。
- 被清理的 Secret 数量。
- 默认 Agent、Reviewer Agent、节点 Agent 和模型匹配结果。
- 缺失工具列表。
- 根来源说明。`file_claim` 必须标记“来源信息未经官方认证”，不能使用与 `catalog` 相同的官方徽标。
- 用户选择的替代 Agent 与模型。

结构错误时对话框只允许关闭，不能确认。仅存在依赖问题时允许“导入为待配置草稿”。

## 主进程与 IPC 边界

文件读取、保存对话框、路径处理、schema 迁移、内容摘要、ID 生成和最终持久化都必须位于主进程。renderer 只展示预览并提交用户选择。

建议增加以下主进程能力：

```ts
interface WorkflowPortableService {
  cloneOfficialWorkflow(workflowId: string): Promise<AppSnapshot>;
  beginImport(): Promise<WorkflowImportPreview | undefined>;
  confirmImport(request: ConfirmWorkflowImportRequest): Promise<AppSnapshot>;
  cancelImport(previewToken: string): Promise<void>;
  exportWorkflow(workflowId: string): Promise<WorkflowExportResult>;
  readiness(workflowId: string): Promise<WorkflowReadinessResult>;
}
```

`beginImport()` 返回 `undefined` 表示用户取消文件选择。`exportWorkflow()` 需要区分成功、用户取消和失败，不能把用户取消显示为错误通知。

对应扩展位置：

- `apps/main-2.0/src/shared/ipc/automation.ts`：通道、请求和响应契约。
- `apps/main-2.0/src/main/ipc/automation.ts`：Zod 边界校验和主进程路由。
- `apps/main-2.0/src/preload/automation.ts`：显式 preload API。
- `apps/main-2.0/src/main/services/automation-service.ts`：组合主进程 Workflow 服务。
- `apps/main-2.0/src/automation/engine/main/hub/workflow/`：克隆、导入、导出、来源和就绪领域逻辑。
- `apps/main-2.0/src/automation/engine/renderer/src/app/services/workflow-service.ts`：renderer 服务接口。

不要让 renderer 接收任意文件路径后自行读取。不要把主进程文件系统 API 暴露为通用读写接口。

## 领域实现边界

建议新增一个有明确边界的领域模块，而不是在组件中拼装 `WorkflowDraftState`：

```text
apps/main-2.0/src/automation/engine/main/hub/workflow/
  workflow-portable-file.ts
  workflow-portable-file.test.ts
  workflow-readiness.ts
  workflow-readiness.test.ts
```

`workflow-portable-file.ts` 负责：

- 文件 schema 和版本迁移。
- 从个人 Workflow 构建可移植文件。
- 定向清理 Secret 值。
- 从文件包生成新的个人草稿。
- 新 ID 改写和非可移植状态归零。
- 来源元数据构建。

`workflow-readiness.ts` 负责当前设备依赖检查。定义结构正确性仍由现有 `validateWorkflowV2Definition(...)` 负责。

克隆、导入和导出在领域逻辑上复用“构建新个人草稿”的同一核心路径，但入口信任级别不同：

- 官方克隆的来源快照由应用内官方记录创建。
- 文件导入的来源字段只作为不可信说明，并强制持久化为 `file_claim`。
- 导出只允许 `sourceType: "user"`。

不要新增只有一个调用者的无意义透传函数。只有文件协议、迁移、就绪检查、来源和原子持久化等独立边界适合形成模块。

## 持久化

`WorkflowDraftState` 需要增加可选 `origin` 元数据。PostgreSQL repository 必须完整读写它。

建议优先使用一个 JSONB 来源字段，以保持可选层级结构和向后兼容：

```ts
origin?: WorkflowOriginMetadata;
```

持久化规则：

- 旧记录没有 `origin` 时按 `undefined` 读取。
- 官方目录记录不依赖 `origin` 判断官方身份，仍以受控 seeding 与 `sourceType` 为准。
- 个人记录的 `origin` 不能把 `sourceType` 改成 `official`。
- `origin.rootOrigin.trust === "catalog"` 只能由应用内官方克隆路径创建。repository 不能从可移植文件直接反序列化出该值。
- repository 读取未知或损坏来源 JSON 时必须失败可见或隔离该字段，不能改变 Workflow 主体来源分类。
- 不恢复已经移除的 SQLite Workflow V2 persistence。

具体 schema 迁移编号在实现时按当前 PostgreSQL migration 序列确定，本文不固定易漂移的编号。

## 错误契约

建议使用稳定错误 code，让 UI 文案与领域错误分离：

| Code | 条件 | 用户结果 |
| --- | --- | --- |
| `WORKFLOW_CLONE_SOURCE_NOT_FOUND` | 官方 Workflow 不存在。 | 不创建副本。 |
| `WORKFLOW_CLONE_SOURCE_NOT_OFFICIAL` | 克隆入口收到个人 Workflow。 | 拒绝，提示使用导出或已有编辑能力。 |
| `WORKFLOW_IMPORT_FILE_TOO_LARGE` | 文件超过 5 MiB。 | 不解析。 |
| `WORKFLOW_IMPORT_INVALID_JSON` | JSON 无法解析。 | 不进入预览。 |
| `WORKFLOW_IMPORT_FORMAT_UNSUPPORTED` | 格式标识缺失或错误。 | 不进入预览。 |
| `WORKFLOW_IMPORT_VERSION_UNSUPPORTED` | schema 版本未知或过新。 | 提示升级或选择受支持文件。 |
| `WORKFLOW_IMPORT_SCHEMA_INVALID` | 文件外壳不符合严格 schema。 | 不进入确认。 |
| `WORKFLOW_IMPORT_DEFINITION_INVALID` | Workflow V2 definition 校验失败。 | 可展示预览错误，不允许创建。 |
| `WORKFLOW_IMPORT_PREVIEW_EXPIRED` | 令牌过期、已消费或摘要不匹配。 | 要求重新选择文件。 |
| `WORKFLOW_IMPORT_MAPPING_INVALID` | 用户映射目标不存在或不可用。 | 保留预览并要求修正。 |
| `WORKFLOW_IMPORT_PERSIST_FAILED` | 新 Workflow 无法原子保存。 | 不切换 active Workflow，不留半成品。 |
| `WORKFLOW_EXPORT_OFFICIAL_FORBIDDEN` | 尝试直接导出官方 Workflow。 | 提示先克隆。 |
| `WORKFLOW_EXPORT_UNSAVED_CHANGES` | renderer 存在未保存编辑。 | 要求先保存或取消。 |
| `WORKFLOW_EXPORT_WRITE_FAILED` | 文件写入或原子替换失败。 | 保持原文件，显示失败原因。 |

错误信息不得回显文件中的 Secret 值、完整脚本输入或凭据内容。

## 兼容性与迁移

### 现有 Workflow 数据

- 现有官方和个人 Workflow 不需要批量转换。
- 新增 `origin` 字段必须可选。
- 现有个人 Workflow 可以立即导出，根来源为空。
- 现有官方 Workflow 可以立即克隆，克隆时建立根来源快照。
- 现有运行历史继续引用原 Workflow ID，不迁移到副本。

### 官方 Workflow 更新

个人副本保存完整定义快照。官方 Workflow 后续升级时：

- 不修改个人副本。
- 不自动提示合并。
- 不比较差异。
- 不改变个人副本的根来源修订。

如果未来增加“从官方更新”能力，必须作为独立设计处理冲突、三方合并、脚本权限变化和 revision 兼容。

## 测试策略

### 文件协议单元测试

- V1 文件可以严格解析。
- 缺少格式、缺少版本、未知字段、错误类型和过新版本被拒绝。
- 已知旧版本按顺序迁移并重新校验。
- `workflowId` 不一致的文件被拒绝。
- 超过 5 MiB 的文件在 JSON 解析前被拒绝。
- 导出后重新导入可以保留标题、目标、definition 和执行默认项。
- 每次导入都生成不同的新 Workflow ID。
- definition 内 Workflow ID 与新本地 ID 保持一致。

### Secret 与脚本测试

- 只移除 `secret` 参数的 `defaultValue` 和 `literalValue`。
- 非 Secret 默认值保持不变。
- 清理后的 Secret 数量准确展示。
- 手工构造的导入文件包含 Secret 字面值时，导入端再次清理且不持久化原值。
- 普通提示词和脚本文本不被导出器擅自改写。
- 导入不执行任何脚本。
- 导入不恢复脚本授权、Run 或审计状态。
- 官方克隆仍然经过现有危险脚本授权路径。

### 来源测试

- 只有应用内官方 Workflow 可以进入官方克隆入口。
- 克隆结果为 `user` 且拓扑解锁。
- 文件声明 `official` 时导入结果仍为 `user`。
- 直接官方克隆的根来源为 `catalog`，文件导入的根来源无条件为 `file_claim`。
- 根来源在官方删除后仍可展示。
- A 克隆官方、B 导入 A 文件后，同时得到本次导入来源和根官方来源。
- 再次导出不携带无限 `importedFrom` 链。

### 依赖和就绪测试

- 稳定 Agent ID 完全匹配时自动绑定。
- 同名不同 ID 不自动绑定。
- Agent 缺失、模型不可用和工具缺失产生准确 issue。
- 用户显式映射后 issue 消失。
- 未就绪 Workflow 可以保存和编辑，但不能确认或运行。
- 当前设备配置变化后就绪结果实时更新。
- 运行时用户输入型 Secret 不被错误判定为必须预先持久化。

### 状态归零测试

克隆和导入结果必须满足：

- `status === "draft"`
- `revision === 1`
- `confirmedRevision === undefined`
- `sourceType === "user"`
- `topologyLocked === false`
- `workDir === undefined`
- 规划消息、回复、错误、运行进度和上下文为空
- Plan、生成审查、报告、会话和 Run ID 为空
- 新生命周期时间由当前创建动作生成

### IPC 与文件系统测试

- 所有文件测试使用临时目录和合成 fixture。
- 不读取真实 HOME、Provider、Claude、Codex、Skill、MCP、Supabase、Electron 或会话数据。
- Windows 文件名非法字符被安全替换。
- Windows 和 macOS 路径行为通过显式平台分支测试。
- 用户取消打开或保存对话框不产生错误。
- 保存失败不破坏已经存在的目标文件。
- 预览令牌不能被消费两次。
- renderer 不能提交篡改后的 definition 绕过主进程摘要校验。

### UI 测试

- 官方卡片显示克隆动作，不显示个人编辑菜单。
- 个人区域显示导入动作。
- 个人详情和菜单显示导出动作。
- 官方详情不允许直接导出。
- 预览对话框完整展示校验、脚本、Secret 和依赖信息。
- 结构错误禁用确认。
- 依赖缺失允许导入草稿，并显示“待配置”。
- 克隆和导入成功后自动选中新副本。
- 同名副本按编号命名。

## 验收标准

功能完成必须同时满足以下条件：

1. 用户可以从官方 Workflow 创建可编辑的独立个人副本。
2. 用户可以多次克隆同一官方 Workflow，每次都得到不同 ID。
3. 用户可以预览并导入有效的单 Workflow 文件。
4. 导入不会覆盖任何已有 Workflow。
5. 用户可以把当前已保存的个人 Workflow 导出并在另一份干净测试环境中重新导入。
6. 文件导入不能获得官方身份。
7. 新副本不包含运行、调度、会话、上下文、工作目录或确认状态。
8. Secret 参数的默认值和字面值不会进入导出文件。
9. 导入脚本继续使用现有脚本治理和授权机制。
10. 缺失 Agent、模型或工具时，用户可以保存草稿，但不能确认或运行。
11. 来源快照在官方 Workflow 改名或删除后仍可读。
12. 用户取消文件选择或保存不会产生错误或空记录。
13. 导入持久化失败时不会留下半成品。
14. 文件协议、领域逻辑、IPC、持久化和 UI 都有针对性测试。

## 建议实施顺序

1. 定义可移植文件、来源元数据、预览、映射和就绪检查共享类型。
2. 实现严格 V1 schema、Secret 清理、版本迁移骨架和领域单元测试。
3. 实现“构建新个人草稿”的克隆与导入核心逻辑。
4. 扩展 PostgreSQL schema 和 repository 以持久化可选来源元数据。
5. 实现就绪检查，并接入 Workflow 确认和运行前置条件。
6. 增加主进程文件选择、预览令牌、保存和原子写入能力。
7. 扩展 IPC、preload 和 renderer Workflow service。
8. 实现官方克隆、导入预览、依赖映射、来源展示和导出 UI。
9. 补齐领域、repository、IPC、UI 和平台路径测试。
10. 添加且仅添加一份用户可见 release note，运行完整验证。

## 验证命令

实现阶段至少运行：

```powershell
npm --prefix apps/main-2.0 run typecheck
npm --prefix apps/main-2.0 run test:workflow-transaction
npm run release-note:check
git diff --check
```

还应针对新增文件协议、repository、IPC 和 UI 测试运行精确的 Vitest 文件列表。不要只依赖广泛测试命令掩盖局部失败。

文档阶段不新增 release note。本文本身是内部设计说明，不是已交付的用户能力。真正实现该用户可见功能的独立开发分支必须按仓库规则添加一份 `.release-notes/<branch-slug>.md`，并在打开 MR 前通过 `npm run release-note:check`。

## 实现审查清单

- [x] 克隆和导入始终生成新 ID，且不覆盖现有记录。
- [x] definition 内 ID 与新 Workflow ID 同步改写。
- [x] 官方来源只由应用内官方目录授予。
- [x] 直接克隆来源和文件声明来源分别使用 `catalog` 与 `file_claim`，UI 不混用官方徽标。
- [x] 文件导入结果强制为个人草稿并解除拓扑锁定。
- [x] 来源只保留本次导入和根官方来源两层。
- [x] 文件严格使用 `agentrecall.workflow` 和受支持 schema 版本。
- [x] 一文件只包含一个 Workflow。
- [x] 导出范围与排除字段表一致。
- [x] Secret 清理只针对 Secret 参数默认值和字面值。
- [x] 导出和导入两端都复用 Secret 清理，文件中的 Secret 字面值不能落库。
- [x] 导入过程不执行脚本，不恢复授权。
- [x] 现有脚本风险分析与权限确认仍然生效。
- [x] 只映射真实存在的 Agent、模型和 required tools。
- [x] Skill、MCP、Provider 和凭据不进入文件。
- [x] `待配置` 是派生就绪结果，不是持久化 Workflow 状态。
- [x] 定义或就绪检查失败时不能确认和运行。
- [x] 工作目录、上下文、规划消息、运行、调度和缓存不进入新副本。
- [x] 导入预览阶段零持久化。
- [x] 预览令牌防篡改、防重复消费。
- [x] 导入保存和导出写入具备原子失败语义。
- [x] 官方、个人和导入来源在 UI 中表达清晰。
- [x] Windows 与 macOS 文件路径测试使用临时环境。
- [x] 实现分支只有一份符合产品文案要求的 release note。

## 实现结果

本设计已在 `apps/main-2.0` 落地，最终交互按产品确认调整为：

- 在官方 Workflow 列表项上右键，选择“Clone to my workflows”。
- 在个人 Workflow 列表项上右键，选择“Export workflow”。
- “Import workflow”位于“New workflow”正下方。

实现覆盖可移植 V1 文件协议、两阶段导入预览、Agent/模型显式映射、Secret 双端清理、脚本静态风险预览、派生就绪检查、确认与运行拦截、来源信任降级、PostgreSQL 来源持久化、单次预览令牌、失败回滚和同目录临时文件替换。当前编辑器的 Workflow 变更通过已有 API 即时保存，因此导出读取的就是当前已保存修订，不存在独立的 renderer 未保存缓冲区。

实现审查完成后运行了类型检查、文件协议与 UI 等定向测试、PostgreSQL schema/repository 测试、Workflow 事务回归、release note 检查和 `git diff --check`。验证结果应以对应开发分支的最新测试输出为准。
