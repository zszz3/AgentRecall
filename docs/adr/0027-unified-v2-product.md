# ADR 0027：退役 V1 并合并为统一的 AgentRecall 2.0

## 状态

已采用；替代 [ADR 0001](0001-product-data-isolation.md)。

## 背景

在 2.0 预览阶段，仓库同时维护了 V1（`apps/main-1.0`，SQLite）和 V2（`apps/main-2.0`，内置 PostgreSQL + 轨迹 / 上下文曲线 / 灵动岛 / 网关 / Agent / Eval / Skill 库 / 团队空间）两套独立应用，并分别使用 `agent-recall` 与 `agent-recall-v2` 两个包名和发布通道。随着 V2 完整覆盖 V1 的会话搜索、恢复、迁移与同步能力，双线维护造成了重复开发、双倍 CI 耗时和割裂的发布与安装体验。

## 决策

1. **移除 `apps/main-1.0`**：仓库只保留 `apps/main-2.0` 作为唯一的桌面端应用源码目录，连同独立 CLI（`apps/cli`）与共享核心（`packages/workspace-core`）。
2. **统一包名、CLI 与 Latest 发布通道**：`apps/main-2.0` 接管主包名 `agent-recall`、命令族 `agent-recall*`、GitHub `Latest` Release 通道（`v2.0.0` 起步，`releases/latest/download/agent-recall.tgz`、`update.json`）以及 macOS 启动器 `AgentRecall.app`。不再维护滚动的 `v2-latest` 指针。
3. **保留磁盘数据隔离边界与显式 V1 导入**：桌面端继续将 Electron `userData` 固定在 `<appData>/agent-recall-v2`、状态与连接指针固定在 `~/.agent-recall-v2`。这样：
   - 已安装过 V2 预览版的用户无缝升级到统一版，无需迁移 PostgreSQL 数据库、托管 Skill 库或设置；
   - 从 V1 升级的用户原有的 `<appData>/AgentRecall/session-search.sqlite` 与 `config.json` 不会被静默覆盖或改写，依然可以通过 **设置 → 关于 → 导入 V1 数据**（`V1SessionImportService`）显式导入历史数据。

## 影响

- 仓库结构、开发命令（`npm run setup` / `dev` / `test` / `build` / `package:smoke`）、CI 矩阵与每日发布流程大幅简化为单一桌面产品。
- V1 老用户通过 `Latest` 通道升级到 `v2.0.0` 时，自动获得内置 PostgreSQL 与全部 2.0 能力，且可按需显式导入旧版 SQLite 数据。
- 历史 `userData` 目录名 `agent-recall-v2` 与 `~/.agent-recall-v2` 作为持久化兼容锚点继续保留，不因对外包名统一为 `agent-recall` 而改动磁盘路径。

## 考虑的替代方案

- **继续双线并行维护**：维护成本高，且无法在统一入口下推进架构重构。
- **将数据目录直接改回 `<appData>/AgentRecall`**：会与未迁移的 V1 SQLite 数据目录重叠，并导致现有 V2 预览版用户升级后“丢库”。保留 `agent-recall-v2` 磁盘锚点兼顾了两类用户的安全升级。

## 关联

[ADR 0001](0001-product-data-isolation.md)、[会话索引规格](../spec/session-indexing.md)、[V1 导入服务](../../apps/main-2.0/src/main/services/v1-session-import-service.ts)、[应用路径引导](../../apps/main-2.0/src/main/app-path-bootstrap.ts)。
