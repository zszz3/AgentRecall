# AgentRecall Install

AgentRecall 2.0 统一了会话管理、轨迹与上下文分析、本地模型网关、灵动岛、Runtime、Agent、Eval、MCP、团队空间和 Skill 库，只需安装一个应用包即可使用全部能力。

## 安装与启动

先确认 Node.js 22.13+ 和 npm 可用，然后安装最新的 GitHub Release：

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz --registry=https://registry.npmjs.org/
agent-recall
```

应用会自动准备内置 PostgreSQL 数据服务，不需要另外安装数据库。内置 PostgreSQL 需要从 npm 下载当前系统对应的平台组件，因此安装命令明确使用 npm 官方源（`--registry=https://registry.npmjs.org/`）；部分镜像缺少平台包却仍可能报告安装成功，请勿替换为其他 npm 镜像。

`--registry` 只影响依赖下载，不会加速 GitHub Release 安装包。GitHub 连接超时时，可先通过浏览器或代理下载 `agent-recall.tgz`，再使用上面的 npm 官方源从本地文件安装。

Electron 运行时下载慢时，可在安装前设置镜像：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

Windows PowerShell 用：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
```

装好后，在任意终端运行 `agent-recall` 即可启动。应用常驻菜单栏或系统托盘，macOS 默认按 **⌥ Option + Space**、Windows 默认按 **Ctrl + Alt + Space** 唤起快速搜索，可在设置中修改或关闭。

### 从 V1 或旧版 V2 预览版升级

- **旧版 V1 用户**：安装 `agent-recall` 2.0 不会修改或覆盖 V1 原有的 SQLite 数据库；启动后可在 **设置 → 关于 → V1 数据迁移** 中一键导入历史会话、标签、收藏和设置。
- **旧版 `agent-recall-v2` 预览版用户**：可直接安装新包 `agent-recall`（并按需执行 `npm uninstall -g agent-recall-v2`），原有的 PostgreSQL 数据库、托管 Skill 库与设置会自动沿用，无需重新导入。

### 常见问题排查

如果安装或启动遇到 Electron 相关错误（如 `Error: ENOENT: no such file or directory, open '.../electron/path.txt'` 或 `dyld: Library not loaded`），请参考 [macOS Electron 安装故障排除指南](docs/troubleshooting-electron-installation.md)。

### 像普通 App 一样打开（macOS）

```bash
agent-recall install-app
```

之后就能从 Launchpad、Spotlight 或 Dock 直接打开 `AgentRecall.app`。启动器优先安装到 `/Applications`，不可写时退回 `~/Applications`。重复执行会原地刷新，`agent-recall uninstall` 会一并删除。

### 后续启动还要 `nvm use 22` 吗？

不需要重新执行 `npm ci` 或构建。如果新终端提示 `agent-recall: command not found`，可以执行 `nvm use 22`，或一次性设置默认版本 `nvm alias default 22`。

### 更新到新版本

日常从终端启动时会自动检查 GitHub Latest Release，也可以主动检查或直接更新：

```bash
agent-recall --check-update
agent-recall --update
```

App 内可在 **设置 → 关于** 检查并安装更新。手动覆盖安装始终使用同一个稳定链接：

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz --registry=https://registry.npmjs.org/
```

安装指定版本或回滚时使用对应 Release tag 的固定链接，例如：

```bash
npm install -g https://github.com/zszz3/AgentRecall/releases/download/v2.0.0/agent-recall.tgz --registry=https://registry.npmjs.org/
```

### 卸载

```bash
agent-recall uninstall
npm uninstall -g agent-recall
```

第一条命令只清理本应用写入的 Claude statusLine、Skill usage hook、会话同步 Hook、MCP 引用、macOS 启动器和集成缓存；它会保留本地会话数据库、Supabase 配置、自动更新偏好及其他用户偏好。第二条命令再删除全局安装的程序包。

### 从源码开发

从源码运行请查看 [CONTRIBUTING.md](./CONTRIBUTING.md)：

```bash
git clone https://github.com/zszz3/AgentRecall.git
cd AgentRecall
npm run setup
npm run dev
```

Windows 上请在普通终端（不要以管理员身份运行）中执行 `npm run setup` 与 `npm run dev`，内置 PostgreSQL 拒绝在管理员权限下启动；`npm run dev` 启动前会检查终端权限和项目目录的完整性级别，未通过时会给出处理命令。
