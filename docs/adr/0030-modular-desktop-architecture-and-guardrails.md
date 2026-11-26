# ADR 0030：桌面端模块化分层架构与自动化边界守卫

## 状态

已采用（Phase 1 入口拆分与自动化架构守卫已落地；Phase 2–5 垂直域演进规划中）。

## 背景

统一 2.0 桌面端（`apps/main-2.0`）经过多轮功能迭代后，形成了若干高频改动巨石文件与跨层耦合风险：

- `src/main/index.ts` 一度超过 3,100 行，集中持有数十个模块级可变状态与散落注册的 `ipcMain.handle/on`；
- `src/renderer/src/App.tsx` 超过 1,700 行，混合全局外壳路由与 Session 页面全部交互状态及弹窗；
- `src/core/platform.ts` 超过 1,700 行，把应用设置 Schema、Shell 转义、终端拉起、文件管理器定位、迁移 CLI 探测和 Resume 命令拼在同一文件中；
- 缺少自动化防回流机制，新功能很容易重新把逻辑或 IPC 注册堆回入口文件，或把 Electron / Node 依赖泄漏进 `src/core` 与 `src/renderer`。

完整的现状扫描、目标垂直域蓝图与分阶段路线见 [桌面端模块化架构设计](../designs/2026-11-25-modular-desktop-architecture-design.md)。

## 决策

1. **入口文件保持为薄编排层（Composition Root），按职责下沉到域模块**：
   - `src/core/platform.ts` 拆分为 `src/core/platform/` 下的独立模块（`app-settings.ts`、`file-manager.ts`、`migration-cli-probe.ts`、`resume-commands.ts`、`shell-quoting.ts`、`terminal-launcher.ts`），入口仅作兼容聚合导出；
   - `src/main/index.ts` 将桌面壳与系统集成迁出到 `src/main/desktop/`（`island-overlay.ts`、`native-dialogs.ts`、`quick-search-window.ts`、`tray-and-dock.ts`、`window-bounds.ts`），将核心业务服务迁入 `src/main/services/`（`automation-bootstrap.ts`、`evaluation-artifact-reader.ts`、`remote-session-migration.ts`、`session-ai-service.ts`、`session-indexing-runtime.ts`），并将全部 IPC 注册收敛到 `src/main/ipc/*.ts`；
   - `src/renderer/src/App.tsx` 将全局偏好/快捷键/IPC 订阅/工作台数据流迁入 `src/renderer/src/features/app/`，将会话详情、弹窗与操作迁入 `src/renderer/src/features/sessions/`。
2. **用自动化脚本守卫跨层边界与文件膨胀上限**：
   - 在 [architecture-boundaries.test.mjs](../../apps/main-2.0/scripts/architecture-boundaries.test.mjs) 中强制执行四条不变量：
     - `src/core/` 生产模块禁止导入 `electron`、`src/main/` 或 `src/renderer/`；
     - `src/renderer/` 生产模块禁止导入 `electron`、`src/main/` 或 `node:*`；
     - `src/main/index.ts` 禁止直接调用 `ipcMain.handle` / `ipcMain.on`（全部经由 `src/main/ipc/*.ts` 注册）；
     - 入口文件行数上限：`src/core/platform.ts` ≤ 80 行、`src/main/index.ts` ≤ 1,100 行、`src/renderer/src/App.tsx` ≤ 900 行（随后续阶段继续收紧）。
   - 配合 [check-source-entrypoints.mjs](../../apps/main-2.0/scripts/check-source-entrypoints.mjs) 校验全部生产源码从声明入口可达，防止重构后残留死模块。
3. **分阶段低风险演进（Phase 2–5 规划，尚未全部实施）**：
   - Phase 2：建立统一 Agent 描述注册表并拆分 `SessionSourceAdapter` 插件；
   - Phase 3：按版本拆分 PostgreSQL 迁移文件并按读写/查询/统计分离 `session-repository`；
   - Phase 4：引入单真源类型化 IPC 映射并收敛历史 Provider 兼容层；
   - Phase 5：收敛 `automation/engine` 平行 UI 与历史多层 CSS。

## 影响

- 核心入口热点的代码规模和跨层耦合显著下降，重构边界由 CI 中的 `test:scripts` 与 `typecheck` 自动把关；
- 任何新增 IPC、桌面能力或核心工具都必须落入所属模块，不能再直接堆进 `main/index.ts`、`App.tsx` 或 `platform.ts`；
- Phase 2–5 仍属后续演进规划，不构成当前代码已完成这些拆分的声明。

## 考虑的替代方案

- **一次性推倒重写目录结构**：风险极高且阻塞日常功能迭代，放弃；
- **仅靠人工 Code Review 约束边界**：随着高频功能提交极易回流，因此必须落盘为自动化边界测试。

## 关联

- [桌面端模块化架构设计](../designs/2026-11-25-modular-desktop-architecture-design.md)
- [应用架构与数据边界](../spec/architecture.md)
- [架构边界守卫测试](../../apps/main-2.0/scripts/architecture-boundaries.test.mjs)
- [入口可达性检查](../../apps/main-2.0/scripts/check-source-entrypoints.mjs)
