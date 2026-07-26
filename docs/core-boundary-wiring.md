# 1.0 Core Boundary 接线状态

1.0 集成已将原生更新、隐私诊断和遗留清理接入受信 Core Boundary。正式打包应用只注册一套原生更新服务；npm 更新器仅保留为用户显式调用的命令行 fallback。

## 主进程与 Core API

### 原生更新

1. `registerElectronUpdater()` 已替换正式应用中的旧更新服务，并保留 `CoreSettings.autoCheckUpdates` 作为用户偏好来源。
2. 在首个窗口的 `ready-to-show` / `did-finish-load` 共用的一次性回调中调用 `firstUsableWindowReady()`。应用启动和窗口可用前不得检查更新。
3. 将更新状态、手动检查、显式下载、安装、重试、复制诊断和打开 Release 映射到 Core IPC。不要把 `electron-updater` 或文件系统能力暴露给 renderer。
4. 使用 `createVersionedDatabaseBackupLifecycle()` 注入当前数据库路径、AgentRecall 自有备份目录和数据库生命周期：
   - `closeDatabase` 必须停止索引任务、关闭 `SessionStore` 并把共享引用置空；
   - `reopenDatabaseAfterFailure` 必须重新创建 `SessionStore`，恢复必要的只读 IPC 和后台状态；
   - 安装启动前不得继续接受会访问已关闭数据库的 IPC。
5. 只在打包运行时注册原生更新。开发模式、测试模式以及 `AGENT_RECALL_NO_UPDATE_CHECK=1` 必须保持离线。

Core API 只暴露 `NativeUpdateState` 与显式更新动作，Renderer 不会同时看到两套更新状态机。

### 隐私与诊断

1. 在受信主进程中创建 `createPrivacyDiagnosticsRegistration()`，只向它传入 Core 允许的 Claude Code / Codex 本地会话读取适配器。
2. Core IPC 继续只暴露搜索、读取、应用自有元数据写入与 Resume；不要增加删除、移动、覆盖上游会话文件的 IPC。
3. 诊断输入从已经存在的版本、平台、数据健康、来源计数、CLI、终端和更新状态组装。诊断模块本身不启动 CLI、不联网。
4. 遗留集成分成检测、预览和应用三个 IPC。检测与预览可以只读；应用清理必须由受信 main-process handler 在独立用户确认后调用，不能把 `applyLegacyCleanup` 直接暴露给 renderer。
5. `homeDir` 和 `backupRoot` 由主进程解析并限制在预期范围；生产备份必须落在 AgentRecall 自有数据目录。

## 1.0 体验层

1. 在 Settings 中加入 `autoCheckUpdates` 开关，并展示原生更新的“检查、下载、安装、重试、复制诊断、打开 Release”状态和动作。下载必须始终由用户明确触发。
2. Diagnostics 页面消费脱敏后的 `PrivacyDiagnosticReport`，显示版本、OS/arch、数据和数据库健康、来源数量、CLI、终端、更新及遗留集成。
3. 遗留集成清理 UI 必须先展示逐文件预览和备份位置，再进行第二次明确确认；不得在启动、诊断或卸载时自动执行。
4. 删除“没有后台轮询”等硬编码结论，改为显示真实策略与诊断结果。平台、3 秒启动和 10k/200ms 只能在 release gate 有证据后出现于发布文案。
5. Markdown 与 Resume 的体验测试应向 1.0 release gate 提交合成 fixture 的证据引用。

## 验证顺序

1. 验证正式 Main、Preload 和 Renderer 只使用 Core API，并确认高级代码只保留在 dormant legacy 边界。
2. `package.json` / `package-lock.json` 是三个分支的已知冲突点。最终结果必须同时保留 Core/体验依赖、`electron-updater`、`electron-builder`、原生打包脚本和 release-gate 脚本；不得恢复会修改外部配置的 `postinstall`。
3. 使用临时 `HOME`、`USERPROFILE`、npm prefix 和合成会话执行安装、更新、卸载、Hook、MCP、诊断与清理测试。
4. 运行 typecheck、build、全部测试、release-note 检查、npm 包冒烟和当前平台可安全执行的原生目录打包。
5. macOS x64/arm64 签名与公证、Windows x64 Authenticode/NSIS、上一签名版本回滚及真实安装器卸载必须在对应平台补齐证据；未验证项保持 `BLOCKED`。
