# 发布打包链路整理设计

## 结论

本次整理只收敛发布打包和暂存依赖整理的代码边界，不改变安装包结构、暂存目录布局、环境变量或原子替换流程。删除 `update-client.cjs` 中的单层转发函数；`stageUpdate` 直接调用现有共享实现。`pack-release.mjs` 保留函数 API 和命令行 API，并补齐清晰的 CLI 入口及错误处理。

影响范围限于当前修复分支。旧版本更新依赖的 postinstall 协议保持不变。

## 历史背景

`v0.31.12` 之前的发布包包含 Electron bridge。打包脚本需要改写 Electron 元数据、构造临时运行时并复制依赖树，`pack-release.mjs` 因此达到 361 行。

`codex/self-contained-legacy-update` 将兼容逻辑移到暂存安装阶段：

- 发布包不再捆绑 Electron，包体保持在 3 MB 以内。
- 旧 updater 传入 `AGENT_RECALL_STAGING_INSTALL=1` 和 `AGENT_RECALL_STAGE_ROOT`。
- 新包的 postinstall 将 npm 提升到外层的运行依赖复制回 `agent-recall/node_modules`。
- updater 在原子替换前检查应用文件和 Electron 运行时。

这次架构调整将打包脚本从 361 行缩减到 32 行，但同时误删了 workflow 依赖的 CLI 入口。

## 兼容边界

以下行为不允许变化：

- `v0.31.3` 至 `v0.31.12` 使用的两个 staging 环境变量名称和值不变。
- `bin/install-claude-statusline.cjs` 的 staging 分支仍在用户配置逻辑之前执行。
- `bin/staged-package-dependencies.cjs` 的目录校验、排除规则和复制行为不变。
- `stageUpdate` 仍在 npm 安装结束、运行时校验开始前整理依赖。
- tgz 文件名、安装包内容、更新清单和原子替换路径不变。
- staging 安装不读取或写入真实用户的 Claude、Codex、npm 或 Electron 数据。

`v0.31.3` 至 `v0.31.7` 依赖新包的 postinstall 完成依赖整理；`v0.31.8` 至 `v0.31.12` 还会由旧 updater 再执行一次整理。共享实现支持重复执行，当前整理不会修改这两个入口。

## 代码调整

### 暂存依赖整理

删除 `prepareStagedPackageDependencies`。它只把参数原样转发给 `materializeStagedPackageDependencies`，同时为了测试而被额外导出。

`stageUpdate` 直接调用 `materializeStagedPackageDependencies`。共享模块继续由独立单测覆盖；`stageUpdate` 集成测试继续验证 Electron 依赖在运行时校验前已经进入新包目录。

### 发布打包 CLI

`packReleaseArchive` 继续负责执行 `npm pack` 并返回归档路径。独立的 CLI 生命周期边界负责：

- 读取 `--pack-destination`，缺省时使用当前目录；
- 调用 `packReleaseArchive`；
- 只向 stdout 输出 tgz 文件名；
- 失败时向 stderr 输出简洁错误并返回非零退出码。

测试通过真实 Node 子进程执行脚本，避免再次出现“函数测试通过、workflow CLI 无输出”的漏测。

## 验证

实现完成后执行：

- `node --test scripts/pack-release.test.mjs`
- `node --test scripts/staged-package-dependencies.test.mjs scripts/install-claude-statusline.test.mjs scripts/update-client.test.mjs`
- `npm test`
- `npm run typecheck`
- `npm run package:smoke`
- `npm run release-note:check`
- 真实打包、资产生成及资产校验
- `git diff --check`

package smoke 和真实资产验证继续使用临时 HOME、npm prefix、npm cache 与临时输出目录。测试结束后清理所有子进程和临时文件。

## 非目标

- 不拆分 `update-client.cjs` 的更新锁、下载、回滚或 Electron 修复逻辑。
- 不删除旧 Electron bridge 的恢复兼容代码。
- 不调整版本计算、发布频率或更新清单格式。
- 不新增用户功能；沿用当前分支已有的一条 Bug 修复 release note。
