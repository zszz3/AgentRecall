# 贡献指南

感谢你对AgentRecall的关注与支持！我们欢迎所有形式的贡献，包括但不限于提交 Bug、提出新特性、完善文档、贡献代码。为了让贡献过程高效顺畅，请仔细阅读以下指南。

## 行为准则

参与本项目即表示你同意遵守我们的行为准则。我们致力于维护开放、包容、友好的社区环境，任何形式的骚扰、歧视、人身攻击或不当言论都将不被容忍。

## 开始之前

### 查找已有信息

- 提交 Issue 前，请先搜索 **Issues** 与 **Discussions**，避免重复提交
- 提交任何改动 PR 前，请先通过 Issue 沟通方案

### 报告 Bug

请使用 Bug 模板提交 Issue，并尽可能包含以下信息：

- 环境信息：操作系统、软件版本、依赖版本
- 复现步骤：清晰可复现的操作流程
- 预期行为与实际行为
- 错误日志、截图或最小复现仓库链接

### 提出新特性

请使用 Feature Request 模板提交 Issue，并说明：

- 该特性解决的问题与适用场景
- 建议的实现方案（可选）
- 是否愿意提交 PR 实现该功能

## 贡献代码

### 开发环境搭建

1. Fork 本仓库到你的 GitHub 账号
2. 克隆 Fork 后的仓库到本地
3. 添加上游仓库，用于同步最新代码
4. 安装项目依赖并运行测试，确保本地环境正常

### 仓库命令与验证范围

```sh
npm run setup:v1              # install the V1 workspace
npm run setup:v2              # install the V2 workspace
npm run setup:cli             # install only CLI and workspace-core dependencies
npm run test:cli              # isolated CLI and configuration tests
npm run package:smoke:cli     # build and isolated CLI install/update/uninstall checks
npm run dev:v1                # run V1 from source
npm run dev:v2                # run V2 from source
npm run test:v1               # V1 tests
npm run test:v2               # V2 tests
npm run typecheck             # typecheck both apps
npm run build                 # build both apps
npm run release-note:check    # validate release-note routing and format
npm run package:smoke         # isolated V1 package smoke test
npm run package:smoke:v2      # isolated V2 package smoke test
npm run release:preflight     # full release preflight; expensive
```

迭代时在受影响应用内运行定向 Vitest，例如工作目录为 `apps/main-2.0` 时使用 `npm exec vitest run src/core/skill-manager.test.ts`。定向检查通过后再按需要运行应用级测试或类型检查。不要默认运行全仓库测试，也不要仅因准备提交就重复已通过的检查；全量检查用于跨仓库改动、CI 排障、发布准备或用户明确要求。

根 npm workspaces 只包含 CLI 和共享配置模块，V1/V2 保持独立安装。CLI 配置、当前限制和源码包验证见 [CLI 指南](docs/v2/cli.md)。

文档结构见 [文档入口](docs/README.md)。日常修改先运行受影响行为的定向检查；安装、更新、进程边界和平台行为变化再补对应集成检查或安装包验证。完整发布预检用于发布准备，不作为每次普通改动的默认步骤。

仅修改文档时检查链接、路径和行为描述，不运行应用构建或全量测试。功能行为、接口或数据边界变化时同步对应 [规格](docs/spec/README.md)；重要架构取舍更新 [ADR](docs/adr/README.md)。模块约定由相应目录的 AGENTS.md 维护。

### 开发流程

1. 同步上游最新代码，基于主干分支创建新分支
2. 分支命名建议遵循以下规范：
   - 功能开发：`feat/xxx`
   - Bug 修复：`fix/xxx`
   - 文档更新：`docs/xxx`
   - 性能优化：`perf/xxx`
   - 重构调整：`refactor/xxx`
3. 在本地完成代码编写，保持每次提交逻辑独立、语义清晰

### 代码规范

- 遵循项目现有的代码风格与目录结构
- 按改动风险补充或更新拥有该行为的测试，避免重复测试实现细节
- 完成上文验证范围要求的检查，并如实记录未运行项和原因
- 公共 API 需补充完整的文档注释
- 避免无意义的重构与格式改动

### 提交信息规范

提交信息遵循 **Conventional Commits** 规范：

```
<type>(<scope>): <subject>

<body>

<footer>
```

**type 类型说明：**

- `feat`：新增功能
- `fix`：修复 Bug
- `docs`：文档变更
- `style`：代码格式调整（不影响功能）
- `refactor`：代码重构（不新增、不修复功能）
- `perf`：性能优化
- `test`：测试相关改动
- `chore`：构建工具、依赖、CI 等变动

### 提交 Pull Request

发布相关改动在提交前可以先运行本地预检：

```bash
# 快速检查发布所用的 macOS/Windows OpenViking wheel 是否仍兼容当前补丁
npm run release:preflight:openviking

# 完整检查 release note，并构建、隔离安装 V1/V2 发布包
npm run release:preflight
```

OpenViking 运行包只跟踪构建脚本、平台矩阵，以及配置中 `nodeDependencies` 声明的 Node 构建依赖闭包。普通 Electron、界面或测试依赖升级不会使运行包失效。真实构建输入发生变化时，PR 校验会要求先提升 `.github/openviking-runtime-inputs.json` 中的 `runtimeVersion`，避免等到定时发布才因同名运行包内容冲突而失败。

V2 独立 macOS App 和 DMG 的本地构建、隔离验证及正式发布边界见 [macOS 打包指南](docs/macos-packaging.md)。

1. 提交前同步上游最新代码，解决冲突

   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. 推送分支到你的 Fork 仓库

   ```bash
   git push origin 分支名
   ```

3. 在 GitHub 页面发起 Pull Request
4. PR 描述请包含以下内容：
   - 关联的 Issue 编号（如 `Closes #123`）
   - 改动内容与设计目的
   - 测试验证情况
   - 必要的截图、示例或说明文档

### Code Review

- 维护者会在合理时间内进行代码评审
- 请积极回应评审意见，及时更新代码
- 评审通过后，维护者会合并你的 PR

## 合并与发布

发布说明的数量、格式、产品路由和措辞以 [.release-notes/README.md](.release-notes/README.md) 为唯一规范。打开或合并 MR 前运行 `npm run release-note:check`，失败时先修复。

- MR 合入 `main` 后累积发布说明，不立即发布。定时流程在北京时间每天 10:00 发布待发布内容；紧急发布可手动触发流程。
- V1/V2 独立版本、独立发布。定时和手动运行都只发布有对应待发布说明的产品；自最近稳定标签以来没有说明时不创建发布。
- V1 的 `vX.Y.Z` 拥有仓库级 `Latest` 和 `releases/latest/download`。V2 使用不可变的 `v2-X.Y.Z` 发布，以及移动的 `v2-latest` 安装与更新指针。
- 保守使用语义版本：常规修复和小行为调整增加 `z`，有意义的能力提升或集中重大修复增加 `y`；增加 `x` 必须获得用户明确确认。
- 当前流程发现任意“新增功能”条目就增加 `y`，只有“Bug 修复”时增加 `z`。仅对足以构成次版本升级的变化使用“新增功能”。
- 紧急发布通过触发发布流程完成；只有修复自动发布流程时才直接创建应用标签或 GitHub Release。

## 常见问题

**可以认领某个 Issue 吗？**
可以在对应 Issue 下留言说明，我们会标记为进行中。

## 社区交流

- 使用 Issues 提交问题与建议
- 使用 Discussions 进行开放式讨论
- 交流请使用文明用语，尊重他人观点

再次感谢你的贡献！每一份提交都让项目变得更好。
