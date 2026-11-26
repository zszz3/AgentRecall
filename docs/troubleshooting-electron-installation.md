# AgentRecall macOS 安装故障排除指南

## 问题描述

在 macOS 上通过 npm 全局安装 AgentRecall 后，启动应用时可能报错：

```
Error: ENOENT: no such file or directory, open '.../electron/path.txt'
```

或 Electron 二进制启动失败：

```
dyld: Library not loaded: @rpath/Electron Framework.framework/Electron Framework
```

## 根本原因

缺少 `path.txt` 通常表示 Electron 的安装脚本没有完整执行。若同时缺少 `Electron.app/Contents/Frameworks`，则说明运行时压缩包的提取过程被中断或结果不完整。仅凭这两个现象无法断定是某个特定 npm 模块的兼容性问题。

## 解决方案

### 推荐：使用 npm 重新安装

最可靠的解决方案是重新安装，再让启动器执行 Electron 完整性校验：

```bash
# 1. 卸载
npm uninstall -g agent-recall

# 2. 重新安装；镜像只用于加速 Electron 下载，npm 依赖仍使用官方源
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz \
  --registry=https://registry.npmjs.org/

# 3. 实际启动；确认应用窗口或菜单栏图标出现
agent-recall
```

`agent-recall --version` 只输出包版本，不能证明 Electron 运行时完整。启动命令会在拉起 Electron 后退出终端进程；请从应用菜单正常退出，不要使用 `$!`、`kill` 或 `Ctrl+C` 判断应用是否启动成功。

### 手动修复（如果重新安装不可行）

如果需要快速修复现有安装，而不重新下载：

```bash
# 1. 定位全局 node_modules 目录（使用 npm root -g，不要硬编码）
ELECTRON_DIR="$(npm root -g)/agent-recall/node_modules/electron"

# 2. 验证路径是否存在（删除前检查）
if [ ! -d "$ELECTRON_DIR" ]; then
  echo "错误：未找到 $ELECTRON_DIR"
  exit 1
fi

# 3. 从已安装包读取精确的 Electron 版本
ELECTRON_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' \
  "$ELECTRON_DIR/package.json")"

# 4. 使用与 Electron 安装脚本一致的架构判断
ELECTRON_ARCH="$(node -p 'process.arch')"
if [ "$ELECTRON_ARCH" = "x64" ] && \
  [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
  ELECTRON_ARCH="arm64"
fi

# 5. 只选择版本和架构完全匹配的缓存文件
CACHE_ROOT="${electron_config_cache:-$HOME/Library/Caches/electron}"
ZIP_NAME="electron-v${ELECTRON_VERSION}-darwin-${ELECTRON_ARCH}.zip"
ZIP_FILE="$(find "$CACHE_ROOT" -type f -name "$ZIP_NAME" -print -quit 2>/dev/null || true)"

if [ -z "$ZIP_FILE" ]; then
  echo "未找到匹配的缓存文件：$ZIP_NAME"
  echo "请使用上面的 Latest 安装命令重新安装"
  exit 1
fi

echo "使用缓存: $ZIP_FILE"

# 6. 先解压到临时目录，不覆盖现有运行时
REPAIR_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-recall-electron.XXXXXX")"
trap 'rm -rf "$REPAIR_ROOT"' EXIT
unzip -q "$ZIP_FILE" -d "$REPAIR_ROOT/dist"

REPAIR_BINARY="$REPAIR_ROOT/dist/Electron.app/Contents/MacOS/Electron"
REPAIR_DEFAULT_APP="$REPAIR_ROOT/dist/Electron.app/Contents/Resources/default_app.asar"
REPAIR_VERSION_FILE="$REPAIR_ROOT/dist/version"

if [ ! -x "$REPAIR_BINARY" ] || [ ! -f "$REPAIR_DEFAULT_APP" ] || [ ! -f "$REPAIR_VERSION_FILE" ]; then
  echo "错误：缓存中的 Electron 运行时文件不完整"
  exit 1
fi

REPAIRED_VERSION="$("$REPAIR_BINARY" --version 2>/dev/null | sed 's/^v//')"
ARCHIVE_VERSION="$(tr -d '\r\n' < "$REPAIR_VERSION_FILE")"
if [ "$REPAIRED_VERSION" != "$ELECTRON_VERSION" ] || [ "$ARCHIVE_VERSION" != "$ELECTRON_VERSION" ]; then
  echo "错误：Electron 版本不匹配，期望 $ELECTRON_VERSION，实际 $REPAIRED_VERSION"
  exit 1
fi

# 7. 验证通过后再替换现有运行时
DIST_BACKUP="$ELECTRON_DIR/.dist-backup-$$"
if [ -d "$ELECTRON_DIR/dist" ]; then
  mv "$ELECTRON_DIR/dist" "$DIST_BACKUP"
fi
if ! mv "$REPAIR_ROOT/dist" "$ELECTRON_DIR/dist"; then
  if [ -d "$DIST_BACKUP" ]; then
    mv "$DIST_BACKUP" "$ELECTRON_DIR/dist"
  fi
  echo "错误：无法替换 Electron 运行时"
  exit 1
fi
if ! printf '%s' 'Electron.app/Contents/MacOS/Electron' > "$ELECTRON_DIR/path.txt"; then
  rm -rf "$ELECTRON_DIR/dist"
  if [ -d "$DIST_BACKUP" ]; then
    mv "$DIST_BACKUP" "$ELECTRON_DIR/dist"
  fi
  echo "错误：无法写入 path.txt"
  exit 1
fi

# 8. 让 Electron 包按正常方式解析并启动二进制验证
if ! ELECTRON_BINARY="$(node -e 'process.stdout.write(require(process.argv[1]))' "$ELECTRON_DIR")" || \
  ! "$ELECTRON_BINARY" --version; then
  rm -rf "$ELECTRON_DIR/dist"
  if [ -d "$DIST_BACKUP" ]; then
    mv "$DIST_BACKUP" "$ELECTRON_DIR/dist"
  fi
  echo "错误：修复后的 Electron 运行时仍无法启动"
  exit 1
fi

if [ -f "$ELECTRON_DIR/dist/electron.d.ts" ]; then
  mv "$ELECTRON_DIR/dist/electron.d.ts" "$ELECTRON_DIR/electron.d.ts"
fi
rm -rf "$DIST_BACKUP"

trap - EXIT
rm -rf "$REPAIR_ROOT"
echo "✓ Electron 运行时修复完成，请运行 agent-recall 验证应用界面"
```

## 验证步骤

完成修复后，确认以下内容：

```bash
ELECTRON_DIR="$(npm root -g)/agent-recall/node_modules/electron"
ELECTRON_BINARY="$(node -e 'process.stdout.write(require(process.argv[1]))' "$ELECTRON_DIR")"

# Electron 二进制能够加载 Frameworks 并输出版本
"$ELECTRON_BINARY" --version

# 启动 AgentRecall，确认窗口或菜单栏图标出现
agent-recall
```

AgentRecall 会将 Electron 作为独立进程启动，因此 CLI 返回后应用仍会继续运行。验证完成后请从应用菜单退出。

## 缓存位置

macOS 默认将 Electron 二进制缓存到 `~/Library/Caches/electron/`。如果设置了 `electron_config_cache`，则使用该环境变量指定的目录。

## 已知限制

- 本文命令面向 npm 全局安装的 `agent-recall`；源码开发环境应在仓库内重新执行 `npm run setup` 与构建命令
- 启动器已包含缺失 `path.txt`、检查缓存完整性等修复流程，不建议直接修改 `node_modules` 中的 Electron 代码
- 镜像源配置（`ELECTRON_MIRROR`）仅加速下载，不能预防解压失败

## 推荐阅读

- [AgentRecall Install.md](../Install.md) - 完整安装指南

## 后续步骤

如果以上方案均不可行，建议：

1. 报告问题到 [AgentRecall Issues](https://github.com/zszz3/AgentRecall/issues)，包含完整的错误日志
2. 附上 `node --version`、`npm --version`、`uname -m`、缓存文件名和完整错误日志
