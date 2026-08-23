# 修复 ZCode 会话删除残留

<!-- release-target: both -->

## Bug 修复

- 删除 ZCode 会话时会一并清理其目标关联记录，避免已删除会话留下无效数据。
