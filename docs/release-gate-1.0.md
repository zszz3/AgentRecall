# AgentRecall 1.0 发布门禁

1.0 只有在安装、核心体验、隐私、更新与退出质量都有可追溯证据时才能发布。门禁不会把“代码存在”“本机跑过一次”或“预期如此”当作通过。

## 状态

- `PASS`：在目标 Release 候选版本上完成测试，记录时间与证据引用，并满足阈值。
- `FAIL`：已经执行且观察到不符合门槛的结果。
- `BLOCKED`：没有执行、缺少平台/签名/资产，或证据不足。`BLOCKED` 不是 `PASS`。

总状态按 `FAIL` > `BLOCKED` > `PASS` 汇总。CLI 退出码分别为 `1`、`2`、`0`。

## 运行

不提供证据时，脚本会安全地输出全部待验证项，不访问用户目录：

```bash
node scripts/release-gate.mjs
node scripts/release-gate.mjs --format json
```

生成一份默认全部 `BLOCKED` 的证据模板：

```bash
node scripts/release-gate.mjs --write-template /tmp/agent-recall-1.0-evidence.json
```

完成隔离测试后填写模板，再生成机器可读报告：

```bash
node scripts/release-gate.mjs \
  --evidence /tmp/agent-recall-1.0-evidence.json \
  --format json
```

仓库包脚本已接入：

```json
{
  "scripts": {
    "release-gate": "node scripts/release-gate.mjs",
    "release-gate:test": "node --test scripts/release-gate.test.mjs"
  }
}
```

## 必须覆盖的门禁

| ID | 验证内容 | 通过条件 |
| --- | --- | --- |
| `install.macos-arm64` | macOS arm64 DMG/zip | 在干净目标环境安装并首次启动；资产、签名/公证结果可追溯 |
| `install.macos-x64` | macOS x64 DMG/zip | 同上，架构为 x64 |
| `install.windows-x64` | Windows x64 NSIS | 在干净目标环境安装并首次启动 |
| `startup.first-window-3s` | 首个可用窗口 | 从进程启动到窗口可交互不超过 3000 ms |
| `search.10k-p95-200ms` | 10,000 条会话搜索 | 合成数据不少于 10,000 条；固定查询集的 p95 不超过 200 ms |
| `render.markdown` | Markdown | 标题、列表、链接、表格、代码块、长行和特殊字符可读且无脚本执行 |
| `resume.claude-code` | Claude Code Resume | 在合成项目中启动正确 CLI、会话和工作目录 |
| `resume.codex` | Codex Resume | 在合成项目中启动正确 CLI、会话和工作目录 |
| `config.persistence-isolation` | 配置 | AgentRecall 设置重启后保留；Claude/Codex/Shell 配置测试前后哈希不变 |
| `privacy.upstream-files-unchanged` | 上游会话只读 | 全部合成上游会话测试前后 SHA-256 相同 |
| `network.disabled-means-off` | 关闭更新后的网络 | 更新关闭、无高级任务启动，观察窗口内意外请求为 0 |
| `update.user-controlled` | 更新发现与同意 | 首个可用窗口后检查、`autoDownload=false`、可关闭；未确认不下载 |
| `update.backup-and-db-close` | 更新前安全点 | 数据库安全关闭且建立可识别版本的备份 |
| `rollback.previous-signed` | 回滚 | 能按文档安装上一签名版本并读取兼容数据/备份 |
| `uninstall.windows-preserve` | Windows 默认卸载 | 移除应用，默认保留用户数据 |
| `uninstall.windows-clean` | Windows 显式清理 | 仅在用户明确选择后清理 AgentRecall 数据，不动上游会话 |
| `uninstall.macos` | macOS 卸载 | 标准卸载和显式清除 AgentRecall 数据步骤均可复现 |
| `quality.no-p0-p1` | 缺陷门槛 | 发布范围内未解决 P0 和 P1 数量均为 0 |

## 证据规则

每个 `PASS` 或 `FAIL` 项必须包含：

- `observedAt`：ISO 8601 时间。
- `evidence`：日志、截图、校验和、测试报告或工单的可定位引用；不得放入凭据或未脱敏路径。
- `notes`：可选的人类说明。

阈值项还必须提供机器校验字段：

- 3 秒启动：`metrics.firstUsableWindowMs`。
- 10k/200ms：`dataset.sessions` 和 `metrics.queryP95Ms`。
- 配置/上游不变：`artifacts` 数组，每项包含相同的 `beforeSha256` 与 `afterSha256`。
- 无网络：`settings.updatesDisabled=true`、`metrics.advancedTasksStarted=0`、`metrics.unexpectedRequests=0`。
- P0/P1：`metrics.p0Open=0`、`metrics.p1Open=0`。

脚本会把声称 `PASS` 但不满足这些字段或阈值的记录降为 `FAIL`，并解释原因。

## 安全测试清单

### 共同隔离要求

- 使用临时 `HOME`、临时 `USERPROFILE`、临时 npm prefix 和合成会话。
- 不读取、上传、重写或删除真实 Claude、Codex、Skills、Supabase、Electron、Shell、npm 或会话数据。
- 安装/更新/卸载前后保存合成上游文件哈希。
- 网络测试使用隔离代理或可审计的阻断环境，不记录 Authorization、cookie、token 或请求正文。
- UI/Electron 测试结束后停止全部进程，清除测试数据库、更新锁、临时运行时和安装包。
- macOS 与 Windows 路径断言必须显式分支，不能把 POSIX 路径当成跨平台结论。

### 安装与首次启动

- [ ] macOS arm64：DMG 安装与 zip 启动分别完成。
- [ ] macOS x64：DMG 安装与 zip 启动分别完成。
- [ ] Windows x64：NSIS 安装完成，开始菜单/卸载入口符合预期。
- [ ] 每个资产的版本、SHA-256、签名/公证状态与构建来源一致。
- [ ] 干净环境首次启动不依赖源码目录或开发依赖。

### 核心体验与性能

- [ ] 启动计时从进程创建到首个可交互窗口，记录冷/热启动口径和原始样本。
- [ ] 用固定种子的 10,000+ 合成会话和固定查询集记录 p50/p95/max；门禁使用 p95。
- [ ] Markdown 覆盖安全链接、列表、表格、行内/块级代码、长行、HTML/脚本输入。
- [ ] Claude Code 和 Codex Resume 分别校验可执行文件、参数、会话标识和工作目录。

### 隐私、配置与网络

- [ ] 对全部合成上游会话做前后 SHA-256 对比。
- [ ] 修改 AgentRecall 设置、重启并验证保留；上游配置哈希不变。
- [ ] 验证 Core 没有删除上游文件的入口。
- [ ] 关闭更新，确认高级任务未启动，在定义好的观察窗口内记录意外请求数。
- [ ] 诊断报告中的 token、key、cookie、Authorization 和选择脱敏的路径不可恢复。

### 更新、回滚与卸载

- [ ] 更新检查发生在首个可用窗口之后；用户可关闭；不自动下载。
- [ ] 下载失败提供稳定错误码、重试、复制诊断和打开 Release。
- [ ] 更新前数据库安全关闭并生成版本化备份。
- [ ] 使用上一签名版本完成回滚；记录数据兼容性与恢复步骤。
- [ ] Windows 默认卸载保留数据，显式清理仅删除 AgentRecall 数据。
- [ ] macOS 标准卸载与显式数据清除说明可复现。

### 发布决策

- [ ] 所有 P0/P1 已关闭并复测。
- [ ] `FAIL` 为 0，`BLOCKED` 为 0。
- [ ] 发布文案只列 `PASS` 的平台和性能结论。
- [ ] 未创建虚假的签名、公证、tag 或 Release 证据。
