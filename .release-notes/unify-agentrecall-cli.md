# 统一 AgentRecall CLI

## 新增功能

- ✨ 将完整 CLI 合并进主安装包：安装 `agent-recall` 即可直接使用全部命令，同时提供 `agent-recall` 与 `agentrecall` 两个等价入口，无需单独构建或安装源码预览包。
- ✨ 新增 `agent-recall --help` 统一帮助、`--version --json` 输出与完整的 `agent-recall doctor` 环境诊断（检查 Node.js、Git、团队配置、工作目录、会话后台与桌面桥接状态）。
- ✨ `directory add` 支持 `--target codex,claude` / `all` 并默认同时接入 `codex` 与 `claude`。

## Bug 修复

- 修复输入 `--help` 或未知子命令时会误启动桌面窗口的问题，现在会明确显示帮助或以参数错误码退出。
- 本机会话无窗口搜索改为进程内直连会话后台，移除跨进程路径探测并清理残留的旧版命令行提示文案。
