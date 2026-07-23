# 修复数字资产面板渲染进程构建失败

## Bug 修复

- 修复 digital-assets-dialog 从 rules-sync/memories-sync 导入值函数导致渲染进程 bundle 拉入 Node 内置模块、Rollup 构建失败的问题，抽取浏览器安全的 asset-identity 共享模块
