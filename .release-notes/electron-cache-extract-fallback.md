# 修复 Electron 运行时解压不完整导致无法启动

<!-- release-target: v1 -->

## Bug 修复

- 🛠️ 修复在较新版本 Node.js 上安装后，Electron 运行时解压不完整导致 `agent-recall` 启动报错的问题；现在启动时会自动从本地缓存重新完整解压，无需重新下载或手动修复。
