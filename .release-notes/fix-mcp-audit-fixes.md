# 修复 MCP OAuth 授权、HTTP Hub 与界面显示问题

## Bug 修复

- 修复保存 MCP 工具源时工具的只读标记（`readOnly`）被意外清空的问题，并在保存环境变量加密凭据时校验变量名格式。
- 修复 HTTP MCP 未设置的宿主环境变量产生空 `Authorization` 请求头覆盖 OAuth Bearer 令牌的问题，并使缺失环境变量诊断按当前传输方式（STDIO / HTTP）精准提示。
- 修复 MCP OAuth「重新授权」与更换地址后无法拉起浏览器或回调端口不匹配的问题；重新授权中途取消时保留原有可用登录态。
- 修复 Streamable HTTP MCP Hub 长期运行时的空闲会话泄漏、非本机 Origin 拦截、`tools/list` 重复查询以及 `search_resources` / `get_resource` 开关可见性不一致的问题。
- 修复直出模式（Direct）工具名在按客户端筛选时发生漂移、调用日志遗漏被拒绝的调用，以及未连接客户端切换 HTTP/STDIO 时误写配置文件的问题。
- 修复 MCP 页面中的样式与显示错误：修复加密凭据保存按钮和「全部已启用工具源」展开按钮被挤压溢出、直出工具仍显示为「索引调用」、以及「调用日志」页样式错位的问题。
