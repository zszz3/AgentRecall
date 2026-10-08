# ADR 0004：Runtime 调度先记录调用，再关联原生会话

## 状态

已采用，补录当前 RuntimeRouter 与 recorder 契约。

## 背景

用户需要知道哪次 AgentRecall 操作产生了哪条原生会话。后端可能新建、续接、失败或超时；请求中提供的 sessionId 并不足以证明后端实际使用了它。

## 决策

调度前持久化 pending invocation，收到后端明确引用后记录 created/continued 绑定，完成持久化终态后再发布成功。缺少生产 recorder 时拒绝启动；不能用仅供测试的 no-op 隐藏接线错误。

调用记录与原生 Session 分开建模；同一 Session 可被多次 invocation 续接。后端已创建 Session 后执行失败仍保留绑定；尚未报告引用的失败请求不伪造绑定。

## 影响

历史关联和失败追踪具有明确证据，Eval 与 Session 页面无需按标题或时间猜测。代价是数据库失败会阻止调度或成功结果，事件与退出回调必须排序；只把日志打印到控制台不足以满足契约。

## 考虑的替代方案

事后扫描最近会话无法可靠区分并发执行。先返回成功、稍后补记录可能让页面展示不存在的关联，并在退出时丢失历史。因此持久化是调用生命周期的一部分。

## 关联

[Runtime 规格](../spec/runtime.md)、[recorder](../../apps/main-2.0/src/automation/engine/main/agents/runtime/runtime-invocation-recorder.ts)、[调用测试](../../apps/main-2.0/src/automation/engine/main/agents/runtime/runtime-router-invocation.test.ts)。
