# ADR 0005：Workflow 恢复绑定图版本与现场证据

## 状态

已采用，补录当前 Workflow v2 事务和恢复边界。

## 背景

Workflow 可以修改文件或执行外部操作。暂停后的图、用户目录和外部结果都可能变化；简单重新执行失败节点可能重复副作用，简单回滚则可能覆盖用户的新修改。

## 决策

区分执行状态与事务状态，检查点绑定 graphVersion。使用事务策略声明 direct、strict_atomic 或 controlled，并在启动前核对隔离、账本和恢复审批能力。缺少历史策略时明确按 direct 兼容，不虚构回滚保证。

恢复依据持久化输出、工作区差异及外部操作证据。冲突方案只供预览，应用前重新验证；Manager 建议与用户确认必须绑定当前事实。未知外部结果先核对，不把非幂等操作当普通重试。

## 影响

可以复用已接受结果，并保护执行期间的用户修改；也必须暴露部分回滚、恢复所需信息和人工步骤。代价是隔离副本、账本、审批和恢复存储，不能把所有错误都压成一个“重试”按钮。

## 考虑的替代方案

每次从头运行成本高且可能重复外部操作；仅保存 UI 节点状态无法证明文件现场；无条件覆盖源目录会丢失并发编辑。当前实现保留证据驱动的恢复过程。

## 关联

[Workflow 规格](../spec/workflow.md)、[事务类型与预检](../../apps/main-2.0/src/automation/engine/shared/workflow-v2/transaction.ts)、[恢复测试](../../apps/main-2.0/src/automation/engine/main/workflows/v2/workflow-v2-recovery.test.ts)。
