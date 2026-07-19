# Rules 跨设备同步核心模块

## 新增功能

- 新增 Rules 同步核心模块（rules-sync.ts），支持扫描本地 Claude CLAUDE.md 和 Qoder .qoder/rules/*.md 规则文件，通过 Supabase 上传/下载实现跨设备同步
- 新增 rulesSyncEnabled 设置项（默认关闭），为后续 Settings UI 和 IPC 集成做准备
