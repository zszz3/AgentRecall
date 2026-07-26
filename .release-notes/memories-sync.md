# Memories 跨设备同步

## 新增功能

- 新增 Memories 同步功能：扫描本地 Qoder 长期记忆（`~/.qoder/memories/`）和 Codex 记忆（`~/.codex/memories_1.sqlite`），通过 Supabase 上传/下载实现跨设备同步
- Settings 页新增「Memories 同步」开关（复用 Skill 同步的 Supabase 配置），支持一键上传所有记忆、按条上传、删除远端记忆
