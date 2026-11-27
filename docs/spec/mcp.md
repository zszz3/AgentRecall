# MCP Gateway 与工具源

范围：V2 MCP Gateway、工具源注册及外部客户端连接。V1 会话 MCP 是独立产品能力，不因此获得 V2 Gateway 的工具目录与控制语义。使用步骤见 [V2 指南](../v2/guide.md)。

## 两层接口

Gateway 的直接工具是 list_skills、get_skill、search_sessions、get_session、search_resources、get_resource；其余工具通过 search_tools、get_tool、call_tool 按需发现和调用。

| 接口 | 输入/输出语义 | 不能推断的能力 |
| --- | --- | --- |
| search_tools | 可选 query、sourceId、cursor、limit；支持多词关键词按工具名/来源名/说明加权匹配与分页，返回精简工具项和 nextCursor | 当前为本地关键词匹配排序，不做外部向量语义搜索 |
| get_tool | toolRef；返回完整说明和 inputSchema | Schema 可读不代表远端服务健康 |
| call_tool | toolRef、arguments；通过常驻连接池复用下游会话并返回底层执行结果 | 目录中存在不代表调用一定成功 |
| 直接工具 | 固定高频会话/Skill 操作 | 不绕过来源和单工具启用开关 |

search_tools 默认页长 20，上限 50；cursor 是非负安全整数的字符串。toolRef 由编码后的 sourceId 和工具名组成，不能把列表位置当成稳定身份。精确实现见 [MCP 服务](../../apps/main-2.0/src/main/services/mcp-automation-module.ts)。

## 注册、发现与缓存

保存新工具源或改变连接字段时尝试发现工具目录。发现成功保存新目录；失败保留上次成功目录并记录错误。仅开关变化不应被当成修改了连接配置。

手动测试内置工具源使用内置启动配置，不能使用 renderer 提交的替代命令绕过约束。内置工具源不能删除，可停用；自定义源删除后需要清理相关绑定并持久化。

目录缓存、最近测试状态和实时调用状态分别表达不同事实。页面必须允许用户看到“目录仍在，但本次刷新失败”。

## 调用权限

每次 get/call 都从当前启用目录解析 toolRef；之前发现过但后来停用、删除或改名的工具不能继续调用。直接工具也要检查对应来源和工具开关。

Agent 绑定的工具源按 Agent 的工具白名单和工具源的单工具开关限制可用工具：Codex 只启用允许的工具，Claude Code 对其余工具设为拒绝。Hermes、OpenCode、OpenClaw 通过 ACP 接收工具源，协议无法按工具限制；绑定的工具源只要会隐藏任一工具，会话就拒绝启动并说明原因，不把整个工具源交给 Agent。

通用索引排除直接工具，避免重复暴露。只在某次运行上下文中有效的临时能力只在所属上下文开放，不得为方便调用放进全局 Gateway。

## 连接客户端

V2 为 Codex 和 Claude Code 管理名为 agent-recall 的 Gateway 配置。客户端连接与工具源开关是两个维度：连接成功只表示客户端配置写入，工具是否开放仍由服务器端当前状态决定。

连接动作同时授权 Gateway 的客户端信任配置，断开时移除对应配置与信任。应用启动修复已启用且检测到的客户端连接；手动断开不能在下次启动被无条件恢复。客户端可能需要重启才能读取新配置，AgentRecall 需要运行才能提供 Gateway。

## 传输、连接池和环境变量

自定义工具源支持 STDIO 或 HTTP。STDIO 子进程与网络连接由主进程 [mcp-client](../../apps/main-2.0/src/automation/engine/main/mcp-client.ts) 中的 `McpConnectionPool` 统一拥有，不由 React 创建。

- **连接复用与有状态会话**：同一工具源在连接配置不变时复用单个 STDIO 子进程或 HTTP/SSE 会话（并发首次连接自动去重），使 Playwright、数据库会话等有状态 MCP 跨调用保持状态。
- **确定性回收**：连接默认空闲 10 分钟自动关闭释放资源；工具源修改连接字段、停用、删除、手动点击「重启连接」、传输中断或应用退出时立即关闭对应进程与会话。仅工具级错误（`isError: true`）或参数校验类 JSON-RPC 错误不销毁健康连接。
- **HTTP → SSE 降级**：HTTP 工具源优先尝试 Streamable HTTP；遇到 404/405/406/415/501 等协议不兼容响应时自动降级到 Legacy SSE（401/403 认证错误与超时不触发降级）。

[mcp-client](../../apps/main-2.0/src/automation/engine/main/mcp-client.ts)默认把配置中的 env 值作为宿主环境变量名解析；显式 literalEnv 是另一条路径。未解析到变量当前会得到空字符串，不能在文档里保证“所有缺失变量都预检拒绝”。配置中引用变量不代表凭据实际存在。

团队 Pull 写入编码客户端的 MCP 配置，与此处 AgentRecall Gateway 注册是不同操作，见 [团队资产](team-assets.md)。

## 验收场景

| 场景 | 期望结果 |
| --- | --- |
| 来源或单工具停用后使用旧 toolRef | 调用被拒绝 |
| 直接 Session 工具被停用 | 不能绕过开关调用 |
| 新源发现失败 | 保留配置和错误，不声称已连接 |
| 已有源刷新失败 | 上次工具目录仍可查看，错误可见 |
| 手动测试内置源携带替代命令 | 使用内置实际配置 |
| 分页 cursor 非法 | 拒绝输入，不静默跳到未知页 |
| 修改客户端连接 | 结果说明配置状态，不假称客户端已重载 |

## Agent 与团队中的 MCP

MCP 页的「Agent 与团队」视图只读列出各个 Agent 自己配置的 MCP 服务和团队 MCP，不经过 Gateway，也不写入任何配置（[ADR 0026](../adr/0026-v2-resource-catalogs.md)）。主进程读取以下文件（[agent-mcp-servers.ts](../../apps/main-2.0/src/core/agent-mcp-servers.ts)）：

| Agent | 用户级 | 项目（有会话记录的本机项目） |
| --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/.claude.json` 或 `~/.claude.json` 的 `mcpServers`，以及其中按项目记录的 `projects.<目录>.mcpServers` | `.mcp.json` |
| Codex | `$CODEX_HOME/config.toml` 的 `mcp_servers` | `.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` |
| Qwen Code | `$QWEN_HOME/settings.json` | `.qwen/settings.json` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` 的 `mcp` | `opencode.json` |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| ZCode | `~/.zcode/cli/config.json` 的 `mcp.servers` | — |

- 名称、传输方式、命令、参数和地址都相同的服务合并为一项，详情列出全部配置位置；项目目录就是主目录时，用户级文件只读一次。
- 环境变量和请求头只返回名称。名称像密钥的参数值、`NAME=value` 形式的参数、地址中的查询参数和用户信息替换为 `[redacted]`，再经过经验卡使用的同一套密钥打码。
- 文件不存在时跳过；存在但无法读取或解析时显示原因，其他文件照常列出。
- 「用编辑器打开」「在文件夹中显示」只接受最近一次列出的配置文件；文件已不在列表中时先重新读取一次，仍不在就拒绝。
- 团队 MCP 来自团队工作副本的目录，详情可以「加为工具源」或回到团队空间编辑。

## 验证入口

[服务测试](../../apps/main-2.0/src/main/services/mcp-automation-module.test.ts)覆盖目录分页、旧引用、开关和发现失败；[客户端测试](../../apps/main-2.0/src/automation/engine/main/mcp-client.test.ts)覆盖环境变量解析；[Gateway 入口](../../apps/main-2.0/src/mcp/gateway-entry.ts)负责外部工具暴露，[Gateway 测试](../../apps/main-2.0/src/automation/engine/mcp/server.test.ts)覆盖直接工具列表和初始化说明；[Agent MCP 读取测试](../../apps/main-2.0/src/core/agent-mcp-servers.test.ts)与[目录服务测试](../../apps/main-2.0/src/main/services/agent-mcp-catalog-service.test.ts)覆盖合并、打码、读取失败和打开文件。

新增工具仍需实现端到端权限和执行边界，不能仅增加 Schema 或依赖调用方提示词限制。


## 会话与资源搜索

查询分流、引用身份、分页一致性和传输失败的完整契约见[检索规格](knowledge-search.md)，操作示例见[Agent 检索指南](../v2/agent-search.md)。

V2 Gateway 的 search_sessions/get_session 和 search_resources/get_resource 分别处理历史过程与可复用资源，不合并排名。本机 search_sessions 的结果先列出匹配的经验卡（cards），再列出会话（sessions），格式见[会话搜索规格](knowledge-search.md#范围与返回模型)。Gateway 在初始化响应的 instructions 中提示 Agent 在排查报错、改动不熟悉的代码或做技术取舍前先调用 search_sessions，并对较旧的结论先核对再用；是否把这段说明加入系统提示由客户端决定。Gateway 本机会话工具使用按需 Node 搜索后台；CLI 优先桌面桥接，桌面不可达时本机会话可转入后台，团队和资源仍使用桌面桥接；范围、分页、限制由 [CLI 指南](../v2/cli.md#分开搜索会话与资源)维护。V1 沿用独立 SQLite 会话 MCP，不读取 V2 团队数据。

[搜索服务](../../apps/main-2.0/src/main/services/knowledge-search-service.ts)校验所有请求，复用本机会话 store、团队会话服务和团队资产工作副本。团队引用包含仓库及分享摘要，每次读取重新验证配置；团队关闭或仓库改变后拒绝旧引用。资源不包含 MCP/Env。没有额外磁盘索引或数据库迁移。

资源工具沿用 Skills 来源开关，并分别检查 list_skills/get_skill 和 search_resources/get_resource 的禁用状态；CLI 不绕过 MCP 权限。接口只读，不调用远程会话补全或 Pull。普通会话按消息分页，可用搜索命中的 turnIndex 从该轮开始读；团队会话按轮次定位读取。每次完整回复最多 1 MiB，资源正文可以继续分页；过大单轮明确报错。

验证：[搜索服务测试](../../apps/main-2.0/src/main/services/knowledge-search-service.test.ts)、[CLI 传输测试](../../apps/main-2.0/tests/cli/search-client.test.ts)、桥接与 MCP 工具定义测试。
