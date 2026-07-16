# MCP 迁移 Bundle 过期时软降级设计

## 背景

独立 MCP 入口 `bin/agent-recall-mcp.mjs` 会加载 `out/mcp/migration-entry.js`，以注册 `migrate_session`。当入口源码更新、但被 `.gitignore` 忽略的 `out/mcp` 仍是旧构建时，bundle 可能缺少入口需要的导出。当前实现会在连接 stdio transport 前抛错，导致整个 MCP 进程退出，Codex 只报告 `initialize response` 前连接关闭。一个可选迁移工具的构建不一致因此会连带禁用搜索、读取和会话管理工具。

## 目标

- 正常 bundle 下保持现有 9 个工具及其行为不变。
- bundle 缺失、导入失败或缺少迁移契约导出时，MCP 仍完成 `initialize`。
- 降级状态下保留 8 个与迁移无关的工具，不注册 `migrate_session`。
- stderr 给出可操作的诊断信息，明确建议运行 `npm run build:mcp`。
- 用真实子进程和 stdio JSON-RPC 覆盖回归场景。

## 非目标

- MCP 启动时不自动调用构建工具。
- 不在运行时修复或覆盖 `out/mcp`。
- 不改变迁移目标、迁移逻辑、数据库结构或客户端配置格式。
- 不为降级状态设计新的 MCP 管理工具或协议扩展。

## 方案

将迁移能力初始化从 MCP 基础能力初始化中隔离出来。服务先创建数据库与 `McpServer`，并注册与 bundle 无关的 8 个工具。随后在局部 `try/catch` 中加载并校验迁移 bundle；只有拿到有效的迁移目标 schema 时才注册 `migrate_session`。

bundle 校验至少覆盖 `MIGRATION_TARGET_IDS` 为非空字符串数组，以及迁移执行所需导出存在。校验失败时向 stderr 输出单行警告，包含失败原因和 `npm run build:mcp`，然后继续连接 `StdioServerTransport`。数据库不存在等基础前置条件仍保持启动失败，因为此时所有工具都不可用。

不采用启动时自动构建：安装环境不保证存在开发依赖，且 MCP 握手不应承担构建延迟与写文件副作用。不采用仅改善致命报错：这仍会扩大可选功能故障的影响面。

## 测试

新增子进程级 MCP 启动测试：在临时目录放置入口脚本、可用数据库和一个模拟旧版本的迁移 bundle，通过环境变量或可注入的 bundle 路径让入口加载该 bundle。测试发送 `initialize`、`notifications/initialized` 和 `tools/list`，断言：

- `initialize` 返回成功；
- `tools/list` 包含现有 8 个基础工具；
- `tools/list` 不包含 `migrate_session`；
- stderr 包含重建提示。

正常 bundle 的启动测试断言 `migrate_session` 仍存在。现有 SDK-free 单元测试继续覆盖迁移 schema 和迁移执行。最终运行 MCP 定向测试、完整测试、typecheck、build，并进行一次手工 stdio 握手探测。

## 验收标准

- 旧 bundle 不再造成 MCP 握手失败。
- 正常构建不丢失或改变任何工具契约。
- 降级原因对用户可诊断、可恢复。
- 所有自动化验证通过，源码工作区不依赖手工保留生成产物。
