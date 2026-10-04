# 修复 Workflow 结果格式导致运行失败
<!-- release-target: v2 -->

## Bug 修复

- 修复 Agent 在 Workflow 结果中引用带双引号的文本时，节点因结果格式错误而失败的问题。
- 修复 Agent 返回完整完成报文时，Workflow 把节点标识等信息误当作业务输出而失败的问题。
