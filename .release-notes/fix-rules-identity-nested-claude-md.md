# Rules 同步修复嵌套 CLAUDE.md 和项目级还原

## Bug 修复

- 修复同项目多个 CLAUDE.md 不可见和身份冲突的问题：扫描器递归子目录（深度 3，跳过 node_modules 等），name 字段改为相对路径（如 `packages/core/CLAUDE.md`），identity 不再冲突
- 还原功能从仅支持全局扩展到支持项目级规则：通过远端 project_path 匹配本地已索引项目目录，拼接相对路径写入文件
