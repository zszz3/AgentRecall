# AgentRecall 桌面应用本地开发

`apps/main-2.0` 是统一的 AgentRecall 2.0 桌面端应用源码目录（包名与 CLI 命令为 `agent-recall`）。面向普通用户的安装、更新与卸载请直接阅读仓库根目录的 [Install.md](../../Install.md)。

## 环境要求

- Node.js 22.13 或更高版本
- npm
- macOS 或 Windows

## 从仓库根目录启动

```bash
npm run setup
npm run dev
```

Windows 上请在普通终端（不要以管理员身份运行）中执行 `npm run setup` 与 `npm run dev`，内置 PostgreSQL 拒绝在管理员权限下启动；`npm run dev` 启动前会检查终端权限和项目目录的完整性级别，未通过时会给出处理命令。

也可以进入 `apps/main-2.0` 后单独运行：

```bash
npm ci
npm run dev
```

## 常用验证命令

在仓库根目录运行：

```bash
npm test
npm run typecheck
npm run build
npm run package:smoke
```

`package:smoke` 会先构建，再把生成的包安装到临时 HOME 和临时 npm prefix 中验证，不会覆盖本机全局安装的版本。

## 数据目录与旧版兼容边界

- 包名、CLI 命令与 GitHub `Latest` Release 通道均为 `agent-recall`（参见 [ADR 0027](../../docs/adr/0027-unified-v2-product.md)）。
- Electron `userData` 固定为 `<appData>/agent-recall-v2`，内置 PostgreSQL 数据保存在该目录下；外部数据库连接指针保存在 `~/.agent-recall-v2/database-url`。
- 保留该磁盘目录锚点可让旧版 `agent-recall-v2` 预览版无缝沿用数据，同时避免覆盖旧版 V1 的 `session-search.sqlite`（可通过「设置 → 关于 → V1 数据迁移」显式导入）。
