# MCP 引用编辑不再覆盖已填内容

## Bug 修复

- MCP Server 详情页里，重复点击「+ Header」不会再把已经填好的 `Authorization` 请求头引用清空：新增条目会自动使用未占用的名称（如 `New-Header`、`New-Header-2`）。「+ Variable」新增环境变量引用同样不再覆盖同名条目。
