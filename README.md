<p align="center">
  <img src="./assets/logo.png" alt="AgentRecall Logo" width="860">
</p>

<h1 align="center">AgentRecall</h1>

<p align="center">在本机搜索、查看并继续 Claude Code 与 Codex 的历史会话</p>

<p align="center">
  简体中文 ｜ <a href="./docs/README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-555555" alt="platform">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

<p align="center">
  <img src="./assets/show.png" alt="AgentRecall 搜索与会话详情" width="860">
</p>

AgentRecall 解决一个具体问题：AI Coding 会话散落在不同项目和工具里，想找回“上次做到哪里”往往比继续工作更费时间。它把 Claude Code 与 Codex 的本地会话放进一个桌面搜索入口。

核心搜索与查看在本机完成，不要求上传会话。AgentRecall 为搜索建立自己的本地索引，不把整理结果写回上游会话文件；可选联网能力和准确边界见[隐私、读写与网络矩阵](./docs/privacy-network-matrix.md)。

## 安装

从 [GitHub Releases](https://github.com/zszz3/AgentRecall/releases) 下载对应平台的安装包：

- macOS：按芯片选择 arm64 或 x64 的 DMG；也可选择对应架构的 zip。
- Windows：选择 x64 的 NSIS 安装程序。

如果目标平台的资产没有出现在 Release 页面，表示该平台尚未发布，不应以源码构建结果代替正式安装包验证。签名、公证、更新、回滚和卸载说明见[原生分发指南](./docs/native-distribution.md)；npm 安装仅作为开发备用，见[高级使用与开发](./docs/advanced-usage-and-development.md)。

## 搜索 → 查看 → 继续

1. **搜索**：输入记得的关键词，跨项目找到 Claude Code 或 Codex 会话。
2. **查看**：打开会话，阅读消息、Markdown、代码块与工具调用上下文。
3. **继续**：选择 Resume，用原来的 Agent 和项目接着工作。

Resume 会调用本机已安装的 Claude Code 或 Codex；AgentRecall 不替代这些工具。

## 文档

- [高级使用、数据位置、开发与排障](./docs/advanced-usage-and-development.md)
- [隐私、读写与网络矩阵](./docs/privacy-network-matrix.md)
- [1.0 发布门禁](./docs/release-gate-1.0.md)
- [演示素材与发布文案](./docs/launch-assets.md)

## License

[MIT](./LICENSE)
