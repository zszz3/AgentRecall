# 子 Agent 会话树设计

## 背景

AgentRecall 已能识别 Codex、Claude、Cursor、ZCode 等来源的子 Agent 会话，并在会话记录中保存 `isSubagent` 和 `parentSessionId`。用户也可以选择在会话列表、项目统计和全局统计中隐藏这些子会话。

当前隐藏后，父会话详情中没有入口查看它派生出的子 Agent 工作，导致任务拆分过程和子任务结果难以追溯。

## 目标

- 保持“隐藏子 Agent 会话”作为列表和统计口径，不改变现有行为。
- 在父会话详情中以独立树形区域展示全部可识别的子 Agent 层级。
- 支持从父会话进入任意子会话，并从子会话返回父会话。
- 本地与 SSH 远程索引会话使用同一套关联规则。
- 对缺失父节点、重复 ID、循环关系和异常规模的数据安全降级。

## 非目标

- 不把子 Agent 的消息合并进父会话时间线。
- 不改变子 Agent 会话的索引格式或数据库字段。
- 不恢复无法从原始会话数据中识别出的父子关系。
- 不把被用户单独标记为隐藏的会话重新显示出来。
- 不改变云端会话同步目前对独立子 Agent 会话的处理范围。

## 交互设计

### 父会话详情

在会话消息区域之后、“相关会话”之前增加「子 Agent 会话」区域。

树的第一层展示父会话直接创建的子 Agent，会话存在更深层后代时显示展开按钮：

- 一级默认展开并直接可见。
- 二级及更深层默认折叠，用户可逐层展开。
- 展开状态只属于当前详情视图，不写入设置。
- 每个节点展示标题、来源、运行环境、消息数、最后活动时间和最多两行摘要。
- 点击节点打开该子会话详情，复用现有详情页导航。

即使“隐藏子 Agent 会话”已开启，这个区域也会显示子会话。该设置只控制列表、搜索结果和统计口径。

### 子会话详情

子会话标题区域下方显示关系导航：

- 父会话存在时显示「父会话：标题」，点击返回父会话。
- 当前子会话仍有后代时，详情下方继续显示以当前会话为根的子树。
- 父会话缺失或不可用时显示「父会话不可用」，不阻断当前详情加载。

### 空状态与截断

- 没有子会话时不渲染树形区域。
- 数据超过安全上限时展示已加载节点，并提示“还有更多子会话未展示”。
- 单个节点读取失败时跳过该节点，不让整个父会话详情报错。

## 关联规则

`parentSessionId` 保存的是父会话的原始 ID，不是完整 `sessionKey`。关联必须限定在同一边界内：

1. `source` 相同；
2. `environmentId` 相同；
3. 子会话的 `parentSessionId` 等于父会话的 `rawId`。

这样可以避免本地、SSH 环境或不同 Agent 工具出现相同原始 ID 时串联。

树查询忽略全局 `hideSubagentSessions` 设置，但排除 `hidden = 1` 的会话，尊重用户对单个会话的明确隐藏操作。

## 数据结构

新增只读关系类型：

```ts
interface SubagentSessionSummary {
  sessionKey: string;
  rawId: string;
  title: string;
  source: SessionSource;
  environmentId: string;
  environmentLabel: string;
  messageCount: number;
  lastActivityAt: number;
  aiSummary: string | null;
}

interface SubagentSessionNode extends SubagentSessionSummary {
  children: SubagentSessionNode[];
}

interface SessionFamily {
  parent: SubagentSessionSummary | null;
  children: SubagentSessionNode[];
  truncated: boolean;
}
```

详情页只接收安全的展示字段，不返回文件路径、原始消息或其他不需要的数据。

## 查询与构树

`SessionStore` 增加 `getSessionFamily(sessionKey)`：

1. 读取当前会话。
2. 在同一 `source + environmentId` 边界内查询未被单独隐藏的父子候选。
3. 使用 `rawId` 建立父节点索引，使用 `parentSessionId` 建立子节点邻接表。
4. 从当前会话开始构建后代树。
5. 如果当前会话是子 Agent，再解析并返回它的直接父会话摘要。

构树使用访问集合防止循环，并设置最多 12 层、200 个节点的保护上限。正常数据仍展示全部层级；达到上限时设置 `truncated = true`。

同一父节点下按 `lastActivityAt` 升序、标题次序排列，以接近任务实际派发顺序并保证结果稳定。

## IPC 与渲染层

- 在 Discovery IPC 中增加类型化的 `getSessionFamily(sessionKey)` 请求。
- Preload 仅暴露该只读方法。
- `App.tsx` 在详情会话变化时并行加载关系树和现有“相关会话”。
- 新增独立的 `SubagentSessionTree` 组件，负责树节点、折叠状态、父会话入口和截断提示。
- `DetailPanel` 接收 `sessionFamily` 与打开会话回调，不负责数据库查询。

关系查询失败时渲染层将其视为空关系，不影响消息、附件和相关会话加载。

## 数据流

```text
打开会话详情
  -> App 请求 getSessionFamily(sessionKey)
  -> Main 调用 SessionStore.getSessionFamily
  -> SQLite 按来源和环境读取父子候选
  -> 构建父节点摘要和后代树
  -> Preload 返回安全展示数据
  -> DetailPanel 渲染父会话入口与子 Agent 会话树
  -> 点击节点复用现有 openSession(sessionKey)
```

## 异常处理

- 当前会话不存在：返回空关系。
- 父会话缺失：`parent = null`，当前详情仍可使用。
- 跨环境或跨来源同 ID：不关联。
- 循环父子关系：在首次重复节点处停止，并标记截断。
- 节点超过上限：停止继续展开并标记截断。
- IPC 查询异常：记录错误并在 UI 中隐藏关系区域。

## 测试

### Store

- 一级父子关系。
- 多级子 Agent 树。
- 子会话查询能返回父会话。
- 同原始 ID、不同来源或不同运行环境不会串联。
- 全局隐藏子 Agent 设置不影响显式关系查询。
- 单独隐藏的子会话不会出现在树中。
- 孤立子节点、循环关系、深度和节点上限安全截断。
- 子节点排序稳定。

### IPC 与 Preload

- 参数校验和返回类型正确。
- 只返回展示字段。
- 查询失败不会影响其他详情 IPC。

### Renderer

- 无子会话时不显示区域。
- 一级节点默认可见，深层节点可折叠。
- 点击节点打开对应详情。
- 子会话显示父会话入口并能返回。
- 截断状态显示提示。

## 发布说明

本分支新增一条用户可见发布说明：父会话详情现在可以查看并打开完整的子 Agent 会话树，即使子会话已从主列表隐藏。
