# V2 灵动岛与本地模型网关设计

## 文档状态

- 状态：实施中。
- 适用范围：`apps/main-2.0`。V1 不做。
- 关联：延续 [界面重做设计](2026-11-22-v2-ui-redesign-design.md) 与 [资源目录设计](2026-11-23-v2-resource-catalogs-design.md)。`Eval` 与 `Runtime` 保持现状，暂不调整；侧栏资源页（`Memory`、`指令`、`Skills`、`MCP`）各自保持独立入口；`团队空间` 保留为团队资产与共享会话核心能力。

## 定位与目标

AgentRecall V2 面向个人与研发团队，提供本机 Coding Agent 的统一运行感知、会话观测与团队资产协作：

1. **实时任务感知（灵动岛）**：覆盖桌面端应用（如 DeepSeek Harness Desktop、Claude Desktop、Codex App、Cursor、ZCode 等）和终端 CLI。当用户在其他窗口工作时，模型开始运行、等待确认、回复完成或出错都会在顶部灵动岛实时提醒，点击即可切回原应用或查看本轮轨迹。
2. **深度会话观测**：继续围绕工作台与 Session 页，提供单行列表、跨轮全文搜索、逐轮轨迹（Trajectory）、上下文缓存与压缩曲线（Context）以及团队分享闭环。
3. **可选本地模型网关**：将 `Provider` 页升级为「网关 / Gateway」，保留原有 `AgentRecall 模型`、`AI 摘要与搜索` 与客户端直连配置，并新增本机 HTTP 模型网关（默认 `127.0.0.1:4325`，默认关闭按需开启），支持一键将网关配置写入主流 Agent 配置文件并可无损还原。

## 灵动岛（Dynamic Island）

### 信号来源与状态机

每个任务（`IslandTask`）由 `${source}:${sessionId}` 标识，状态为 `running | waiting_input | completed | error`：

1. **本地会话日志增量监听（开箱即用，不依赖网关）**：
   - 启动时仅记录最近活跃文件的当前字节偏移作为基线，不把历史旧会话误报为刚完成。
   - **DeepSeek Harness（DSH Desktop / CLI）**：按 `committedBytes` 增量扫描 `~/.dsh/sessions/<project>/<id>/session.v4.jsonl.zstd`（及兼容版本）的新增帧。`turn/start`、`step/start`、`tool/call` 推进至 `running`；`turn/end`（`reason.kind === "completed"`）或不含 `tool-call` 的最终 `assistant/message` 推进至 `completed`；`turn/end`（`reason.kind === "error"`）推进至 `error`。
   - **Claude Code / Codex / Pi / ZCode**：对近期活跃会话文件增量读取新增尾行，识别用户提问、工具调用、最终回复与错误。
2. **本地网关实时流事件（零延迟增强）**：
   - 走本地网关的请求在开始时标记 `running`；流式或非流式返回以非工具调用结束时标记 `completed`；429/5xx/传输错误标记 `error`。与日志监听按会话或近期窗口去重，避免重复提醒。
3. **本机事件接入（供 Hook 推送）**：
   - 预留 `POST /island/event` 机制，允许外部 Hook 直接推送 `waiting_input` / `completed` / `error`。

### 窗口与交互规则

- 独立无边框透明置顶窗口（`focusable: false`），绝不抢占当前输入焦点；无交互区域鼠标穿透，不遮挡系统菜单栏点击。
- **前台防打扰**：当目标桌面应用已处于系统前台且开启「前台免打扰」时，静默更新状态而不弹出完成卡片与提示音。
- **动作直达**：点击卡片将对应桌面应用（如 DeepSeek Harness Desktop）或终端 Tab 唤起到前台；提供「看轨迹」跳转至 Session 详情与「分享到团队」跳转至团队上传清单。

## 本地模型网关（Provider 页升级）

### 服务契约

- 默认监听 `127.0.0.1:4325`（端口可配），默认关闭；开启后支持：
  - `GET /health`、`GET /v1/models`
  - `POST /v1/chat/completions`（OpenAI Chat Completions）
  - `POST /v1/responses`（OpenAI Responses）
  - `POST /v1/messages`（Anthropic Messages）
  - 可选路径前缀 `/agent/<agentId>/v1/...` 显式标识来源 Agent。
- 支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 之间的流式与非流式协议互转（含工具调用）。
- 支持多上游 Provider（可导入本机 Agent / CC Switch 配置，密钥保存在主进程密钥存储中，不暴露给渲染进程）、默认主路由与顺序 Fallback（仅在尚未向客户端发送响应字节且上游返回 429/5xx/网络错误时切换备用路由）。
- 记录有界内存请求环（状态、Agent、模型、上游、TTFT、总耗时、Token 与脱敏错误信息），退出时中止在途请求并关闭全部连接。

### 一键写入与还原 Agent 配置

支持检测并一键写入/还原以下本地 Agent 配置：

- **Claude Code**（`~/.claude/settings.json`）
- **Codex**（`~/.codex/config.toml`）
- **DeepSeek Harness**（`~/.dsh/profiles/<profile>/cordis.patch.yml` 与凭据引用）
- **Pi**（`~/.pi/agent/models.json`）
- **OpenCode**（`~/.config/opencode/opencode.json`）

写入统一经原子写入工具完成，并在应用数据目录保存写入前快照；点击「还原」仅恢复 AgentRecall 改动的字段或快照。

## 明确边界

- 不合并 `Memory`、`指令`、`Skills`、`MCP` 为单一页面。
- 不修改或删除 `Eval` 与 `Runtime`。
- 不实现各厂商订阅账号的逆向桥接。
