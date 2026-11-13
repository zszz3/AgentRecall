# 修复 Codex 自动安全审查过滤与 Antigravity 附件展示

<!-- release-target: both -->

## Bug 修复

- 修复 Codex 开启自动安全审查时内部 `Guardian review` 审查记录混入会话列表的问题，并在刷新索引时自动清理已误收录的记录。
- 修复 Antigravity 会话中用户消息附带的图片与媒体附件无法展示的问题，纯图片提问也能正常生成会话标题。
- 修复新版 Antigravity 会话中文件读写、终端命令、目录浏览与子代理调用等工具卡片缺少参数摘要的问题。
