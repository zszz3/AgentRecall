# ADR 0029：将独立 CLI 合并入统一的 `agent-recall` 发布包

## 状态

已采用；延续 [ADR 0027](0027-unified-v2-product.md) 与 [ADR 0012](0012-on-demand-session-backend.md)。

## 背景

在 [ADR 0027](0027-unified-v2-product.md) 将桌面应用统一为单一包 `agent-recall` 后，仓库仍保留了独立的 `apps/cli`（`agentrecall-cli@0.1.0`，`private: true`），造成以下结构性问题：

1. **双入口割裂**：用户安装的 `agent-recall` 只包含桌面启动、更新与本机 `session`/`backend` 子命令；团队配置、目录同步、资源搜索与资产管理命令在未发布的 `agentrecall` 预览包里。
2. **跨进程回退链路脆弱**：独立 `agentrecall` 执行无窗口本机会话检索时，必须在 `PATH` 中扫描已安装的 `agent-recall`、解析 Windows `.cmd` shim 再通过子进程调用它。
3. **重复维护与 CI 开销**：独立的根工作区锁文件、单独的 `esbuild` 全量打包和独立 3 平台 `package:smoke:cli` 流程，却从未接入正式发布工作流。

## 决策

1. **合并源码并退役 `apps/cli`**：将 CLI 实现移入 `apps/main-2.0/src/cli/`，由 `scripts/build-cli-bundle.mjs` 复用主包已有生产依赖打成 `out/cli/index.js`，随主包 `agent-recall.tgz` 一起正式发布。
2. **统一双别名入口**：`apps/main-2.0/package.json` 同时暴露 `agent-recall` 与 `agentrecall` 两个 bin，均指向 `bin/agent-recall.cjs`。
   - 无参数或仅桌面启动参数（`--no-update-check`、`--wait-pid`）继续启动 Electron 桌面端；
   - `--help` / `-h` / `help` 输出统一帮助且不拉起桌面；
   - 未知子命令或无效参数明确以退出码 `2` 拒绝，不再误拉起 Electron；
   - `backend` 与 `init`/`status`/`doctor`/`session`/`resource`/`team`/`directory`/`skill`/`work-config`/`project` 全部由同一入口分发。
3. **进程内直连无窗口搜索后台**：`src/cli/search-client.ts` 在桌面桥接不存在或拒绝连接时，对本机会话检索直接进程内调用 `bin/session-backend-client.cjs`，移除 `PATH` 扫描与子进程桥接。
4. **保持磁盘与配置契约不变**：团队配置仍保存在 `~/.agentrecall-cli/config.json`（受 `AGENTRECALL_HOME` 控制），桌面数据与后台发现文件继续沿用 `<appData>/agent-recall-v2`（并尊重 `AGENT_RECALL_USER_DATA_DIR` / `AGENT_RECALL_MCP_BRIDGE`）。
5. **共享核心与 CLI 测试迁入主包验证矩阵**：原 `apps/cli/test` 迁至 `apps/main-2.0/tests/cli`，在 Linux / macOS / Windows 的主包测试和 `package:smoke` 中统一验证。

## 影响

- 安装 `agent-recall` 即开箱获得完整 CLI（`agent-recall` 与 `agentrecall` 命令等价），无需单独克隆仓库或本地打包。
- 仓库移除根级 `workspaces`、根 `package-lock.json` 与冗余的独立 `cli` CI 任务，所有检查收敛到单一主包锁文件与跨平台 `verify` 矩阵。
- `doctor` 升级为真正的本地环境与连接诊断命令，`directory add` 默认接入 `codex,claude` 并支持逗号分隔目标。

## 考虑的替代方案

- **继续作为独立 npm 包发布 `agentrecall-cli`**：仍需维护两套发布产物、处理版本错配以及跨平台 `PATH`/`.cmd` 互调，对同时使用桌面端和终端的开发者增加额外安装负担。

## 关联

[ADR 0027](0027-unified-v2-product.md)、[ADR 0012](0012-on-demand-session-backend.md)、[CLI 指南](../v2/cli.md)、[应用架构规格](../spec/architecture.md)、[主入口](../../apps/main-2.0/bin/agent-recall.cjs)、[统一 CLI](../../apps/main-2.0/src/cli/index.ts)。
