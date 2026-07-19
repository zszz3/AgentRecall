# Rules 跨设备同步

## 新增功能

- 新增 Rules 同步功能：扫描本地 Claude CLAUDE.md 和 Qoder .qoder/rules/*.md 规则文件，通过 Supabase 上传/下载实现跨设备同步
- Settings 页新增「Rules 同步」开关（复用 Skill 同步的 Supabase 配置），支持一键上传所有规则、按条上传、删除远端规则
- 新增 rulesSyncEnabled 设置项（默认关闭）
