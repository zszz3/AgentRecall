# 修复 Qoder 会话标题显示为路径或乱码

## Bug 修复

- 修复 Qoder 数据源会话标题显示为路径或哈希乱码的问题，根因是 `qoderContentFromRow` 未剥离 Qoder 特有的 `<system-reminder>`/`<attached_files>`/`<user_query>` 包装标签，导致 `isMeaningfulUserMessage` 误判所有用户消息为系统消息而跳过，标题回退到 rawId
