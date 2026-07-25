# AgentRecall 原生分发、更新与卸载

AgentRecall 1.0 的原生分发边界生成以下安装包：

- macOS arm64/x64：DMG 与 zip
- Windows x64：按当前用户安装的 NSIS 安装器

`npm` 包只保留给开发和恢复场景。安装 npm 包不会再通过 `postinstall` 修改 Claude Code、Codex、Shell 或 npm 配置；需要集成时必须运行显式设置命令并先查看预览。

## Core Boundary 接线

原生更新模块没有改动主进程启动架构。集成方需要在主进程完成四个接线点：

1. 调用 `registerElectronUpdater()`，注入更新开关、剪贴板、外链、调度器和数据库备份生命周期。
2. 第一个 `BrowserWindow` 触发 `ready-to-show` 后，调用控制器的 `firstUsableWindowReady()`。在此之前不发更新网络请求。
3. 用设置项调用 `setAutomaticChecksEnabled(false)` 可关闭自动检查；关闭后计划任务也会在执行前再次校验开关。手动检查仍由用户显式触发。
4. 在 UI/IPC 中暴露 `check()`、`download()`、`installDownloadedUpdate()`、`retry()`、`copyFailureDiagnostics()`、`openFailureHelp()` 和 `openReleases()`。

`electron-updater` 被固定为 `autoDownload=false` 与 `autoInstallOnAppQuit=false`。发现版本不会自动下载，下载完成也不会在普通退出时静默安装。不要同时启用既有 npm 更新服务和原生更新控制器；切换到原生分发时由主进程选择唯一实现。

## 更新安全与故障处理

安装前必须通过 `createVersionedDatabaseBackupLifecycle()` 注入真实数据库路径、备份目录以及数据库关闭/失败重开回调。模块按以下顺序工作：

1. 安全关闭 SQLite；
2. 将数据库及存在的 WAL/SHM 文件复制到带来源版本、目标版本和时间戳的目录；
3. 写入不包含绝对路径的 `backup.json`；
4. 仅在备份成功后启动原生安装器；
5. 备份失败时不安装并重新打开数据库；安装器同步启动失败时也调用恢复接口。

错误状态带稳定错误码、可重试标记、故障报告 URL、Release URL 和可复制诊断文本：

- `NATIVE_UPDATE_CHECK_FAILED`
- `NATIVE_UPDATE_DOWNLOAD_FAILED`
- `NATIVE_UPDATE_BACKUP_FAILED`
- `NATIVE_UPDATE_INSTALL_FAILED`
- `NATIVE_UPDATE_NOT_READY`
- `NATIVE_UPDATE_UNTRUSTED_ROLLBACK`

诊断文本只包含产品版本、目标版本、OS/arch、错误码和错误消息，不主动加入用户目录或数据库绝对路径。

## 回滚到上一签名版本

回滚必须使用 Release 页面中“上一已验证签名版本”的资产，不能自动选择任意旧安装包。调用 `createSignedRollbackPlan()` 前，发布层需从受信发布元数据确认版本、资产 URL、签名状态和签名者。

- macOS：退出应用，保留更新前备份，从已验证 Release 下载旧 DMG，使用 `codesign --verify --deep --strict` 和系统签名信息确认 Developer ID，再替换 `/Applications/AgentRecall.app`。
- Windows：退出应用，保留更新前备份，从已验证 Release 下载旧 NSIS，先在文件“数字签名”属性或 `Get-AuthenticodeSignature` 中确认签名者，再运行当前用户安装器。

签名未知或不匹配时，回滚接口返回 `NATIVE_UPDATE_UNTRUSTED_ROLLBACK`，不得继续。数据库若已被新版本不可逆迁移，应先复制当前数据，再由受支持的恢复流程使用版本化备份；不要让旧版本直接写入不兼容的新数据库。

## 卸载与数据清理

Windows 卸载器默认保留 `%APPDATA%\AgentRecall`、更新缓存、版本化备份和 `%USERPROFILE%\.agent-recall`。卸载结束时会询问是否同时清除 AgentRecall 本地数据，“否”是默认选项；只有明确选择“是”才删除 AgentRecall 自有目录。Claude Code 与 Codex 的上游会话文件始终不在该删除范围内。

macOS 使用标准卸载：退出 AgentRecall，将 `/Applications/AgentRecall.app` 移到废纸篓。此操作保留本地数据。用户明确要求清理时，再删除以下 AgentRecall 自有位置：

- `~/Library/Application Support/AgentRecall`
- `~/Library/Caches/dev.zszz3.agent-recall`
- `~/Library/Preferences/dev.zszz3.agent-recall.plist`
- `~/.agent-recall`

不要删除 `~/.claude`、`~/.codex` 或其中的会话。遗留 MCP/Hook/StatusLine 应通过隐私清理模块预览、备份后，只移除 AgentRecall 自有条目。

## 签名、公证和构建

本地 unsigned 验证：

```sh
npm ci --ignore-scripts
npm run package:native:smoke
```

完整平台资产：

```sh
npm run package:native:mac
npm run package:native:win
```

手动 GitHub Actions 工作流只上传 workflow artifact，不创建 tag 或 Release，也不发布更新。`signed=false` 会清空凭据并关闭签名自动发现，适合 unsigned 验证。`signed=true` 缺少任一所需 secret 会明确失败：

- macOS：`MACOS_CSC_LINK`、`MACOS_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
- Windows：`WINDOWS_CSC_LINK`、`WINDOWS_CSC_KEY_PASSWORD`

仓库不包含、推断或伪造任何证书和公证凭据。最终发布前必须在对应真实平台验证签名、Gatekeeper/SmartScreen、安装、升级、回滚和卸载行为。
