# 高级使用、数据位置、开发与排障

README 只介绍 AgentRecall 的核心工作流。本文收纳可选能力、底层路径、开发方式与复杂排障；这些能力不改变产品的主要定位：在本机找回 Claude Code 与 Codex 会话。

## 核心与可选能力

核心工作流包括本地索引、关键词搜索、会话详情和 Resume。Resume 依赖本机已经可用的 Claude Code 或 Codex CLI。

仓库中还包含标签、收藏、隐藏、Markdown 导出、可选来源、SSH 环境、MCP、Hook、AI 摘要、远程会话同步、Skills 管理与 Provider 配置等高级能力。它们有各自的读写与网络边界，不应被理解为全部默认启用，也不应笼统宣传成“支持所有 Agent”。启用前先查看[隐私、读写与网络矩阵](./privacy-network-matrix.md)和界面中的明确提示。

## 数据源与只读边界

核心来源的常见路径如下；实际位置可能受工具版本和用户配置影响。

| 来源 | 常见上游路径 | 核心索引行为 |
| --- | --- | --- |
| Codex CLI / Desktop | `~/.codex/sessions/**/*.jsonl` | 读取并写入 AgentRecall 自有索引 |
| Codex 标题元数据 | `~/.codex/session_index.jsonl` | 存在时读取 |
| Claude Code | `~/.claude/projects/*/*.jsonl` | 读取并写入 AgentRecall 自有索引 |
| Claude Code 元数据 | `~/.claude/sessions/*.json` | 存在时读取 |
| Claude Desktop | `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json` | 存在时读取 |

标签、收藏、自定义标题、隐藏状态和搜索索引属于 AgentRecall 数据，不应写回上游会话。Resume 之后由上游 CLI 自己产生的新内容不属于 AgentRecall 对上游文件的修改。

扩展来源及其能力随版本变化。只有 Release 门禁已经验证的来源和平台才应写入发布结论。

## AgentRecall 自有数据

Electron 通常把应用数据放在：

- macOS：`~/Library/Application Support/AgentRecall`
- Windows：`%APPDATA%\AgentRecall`

其中可能包含搜索索引、应用设置、更新状态和备份。诊断报告应优先使用脱敏路径，不应包含凭据。原生更新、版本化备份、回滚和卸载的数据保留规则见[原生分发指南](./native-distribution.md)。

历史版本可能安装过 AgentRecall MCP、Hook 或 statusLine 条目。诊断只应检测并预览；清理必须由用户明确触发、先备份，并且只删除 AgentRecall 自有条目。接口和接线要求见[隐私与诊断接口](./privacy-diagnostics-interface.md)。

## 联网能力

本地搜索与详情不需要网络。检查更新、打开 Release 页面、远程同步、自定义 AI 摘要、SSH 和第三方 Provider 等能力可能使用网络。关闭更新检查和高级任务后，不应存在自动网络请求；这项结论必须由 1.0 门禁的隔离网络测试证明，不能仅根据设计推断。

## 开发

要求 Node.js 22.13 或更高版本。开发环境使用：

```bash
git clone https://github.com/zszz3/AgentRecall.git
cd AgentRecall
npm ci
npm run dev
```

常用验证：

```bash
npm test
npm run typecheck
npm run build
npm run release-note:check
node scripts/release-gate.mjs --format json
```

安装、更新、卸载、Hook、MCP 和会话发现测试必须使用临时 `HOME`、临时 npm prefix 与合成会话，不能读取或修改开发者真实的 Claude、Codex、Shell、npm 配置和会话数据。

npm 包只作为开发备用。隔离的包冒烟测试应先完成构建，再把生成的 tarball 安装到临时 prefix，验证 CLI 后清理临时文件和子进程：

```bash
npm run build
npm run package:smoke
```

## 排障

### 搜不到会话

1. 确认会话由 Claude Code 或 Codex 产生，并且本机上游文件仍存在。
2. 检查来源筛选、时间筛选和项目范围。
3. 查看诊断中的来源数量、数据健康和 CLI 检测结果。
4. 不要为了“重新索引”而删除上游目录；仅重建 AgentRecall 自有索引。

### Resume 失败

1. 在终端直接确认 `claude` 或 `codex` 命令可用。
2. 确认项目路径仍存在且当前用户有权访问。
3. Windows 检查所选终端是否已安装；macOS 检查终端授权。
4. 复制诊断信息时先确认路径和凭据已经脱敏。

### 更新失败

保留错误码和诊断信息，再按失败界面提供的 Release 链接执行手动恢复。不要删除应用数据或上游会话。具体重试、备份与上一签名版本回滚步骤见[原生分发指南](./native-distribution.md)。

### 遗留集成

先运行诊断并查看清理预览。只有备份成功后才能执行显式清理；不应使用覆盖整个 Claude、Codex 或 Shell 配置的办法移除单个 AgentRecall 条目。

## 验证状态

平台安装、3 秒启动、10,000 条会话搜索 200 ms、无自动网络、更新、回滚和卸载都属于发布门禁，不是本文宣称已经达到的结论。以同一 Release 候选版本生成的[机器可读门禁报告](./release-gate-1.0.md)为准。
