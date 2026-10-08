# Workflow 执行与恢复

范围：V2 Workflow v2 的图定义、规划确认、节点执行和恢复。操作入口见 [V2 指南](../v2/guide.md)。旧 Workflow 或历史记录的兼容路径不能被误读为所有新流程的默认行为。

## 核心对象

| 对象 | 主要内容 | 生命周期 |
| --- | --- | --- |
| Definition | 节点、边、图版本、执行及事务策略 | 可编辑定义 |
| Plan | 解析后的节点、路由和 task packet | 本次执行使用的计划 |
| RunState | graphVersion、节点状态、依赖、锁、并发上限 | 本次运行 |
| WorkerOutput | 节点输出与结果包 | 校验、Review 和下游消费 |
| Checkpoint | runState 与 workerOutputs | 暂停/中断后恢复 |
| Transaction | 隔离目录、账本、提交及恢复状态 | 文件变更和外部操作治理 |

定义接口见 [definition](../../apps/main-2.0/src/automation/engine/shared/workflow-v2/definition.ts)，计划接口见 [planning](../../apps/main-2.0/src/automation/engine/shared/workflow-v2/planning.ts)。编辑中的定义不能直接替换已在运行的图版本。

## 规划与确认

用户选择规划 Agent、模型和工作目录，逐步提供目标与约束，生成图后检查节点、输入输出和路由。生成后的 Review 结果带 reviewedRevision；修改图版本不能继续把旧 Review 当成当前批准。

LLM 节点需要自己的有效 Agent 路由，不能从无关节点或列表首项补齐。脚本节点需要执行声明和授权策略，图结构合法也不代表执行环境或权限已经准备好。

[生成 Review 状态](../../apps/main-2.0/src/automation/engine/shared/workflow-v2/generation-review.ts)区分未审、审查中、批准、要求修改和失败；调用错误不能转成“没有发现问题”。

## 节点状态

以下为主要执行路径；完整合法转换以调度器为准，不是任意状态都能互相切换。

| 状态 | 含义 | 后续处理 |
| --- | --- | --- |
| blocked | 依赖尚未满足 | 等待上游结果 |
| ready | 可被调度 | 还需满足并发和资源锁条件 |
| running | 节点执行中 | 收集输出或失败 |
| validating | 检查输出契约 | 通过后按策略 Review；失败按策略处理 |
| awaiting_review | 等待结果审查 | 接受、重试、暂停或失败 |
| paused | 等待人工介入 | 按当前 intervention 接受有效操作 |
| completed / completed_with_override | 正常完成或人工覆盖完成 | 保留两种结果的区别 |
| skipped / failed | 跳过或失败 | 不能伪造成功输出 |

执行层 RunState 状态为 running、paused、completed、failed。不要把它与更外层历史记录或事务状态的枚举混为一谈。实现见 [state](../../apps/main-2.0/src/automation/engine/shared/workflow-v2/state.ts)。

## 调度与输出

[执行器](../../apps/main-2.0/src/automation/engine/main/workflows/v2/workflow-v2-executor.ts)接收已解析计划以及 LLM、脚本、Review、Hook、检查点等回调，返回运行状态和 worker outputs。调度依据依赖、资源锁和 maxParallelNodes；节点收到 task packet 和上游输出，不从 renderer 临时状态读取输入。

节点成功退出还需经过输出校验；Review 有自身的失败与重试记录。基础设施失败和质量拒绝应保留原因，不能统一记成模型没有完成任务。保存检查点失败也不能被当成“只丢失了显示进度”。

## 事务模式

| 模式 | 边界 |
| --- | --- |
| direct | 直接执行，不承诺回滚 |
| strict_atomic | 需要隔离工作区、可写账本和恢复审批能力；不允许无约束外部脚本冒充可回滚执行 |
| controlled | 需要外部操作 broker、可写账本和恢复审批能力 |

历史定义未带事务策略时解析为 direct，并给出兼容提示。模式要求不满足时预检失败，不能静默降级。具体预检见 [transaction](../../apps/main-2.0/src/automation/engine/shared/workflow-v2/transaction.ts)。

事务状态独立包含 active、waiting_for_user、committing、committed、rolling_back、rolled_back、partially_rolled_back、recovery_required。部分回滚与需人工恢复都不是回滚成功。

## 恢复和冲突

同图版本的检查点可以复用已接受结果，包括有记录的人工覆盖结果。恢复时重新检查隔离目录、持久化证据和事务条件；目录消失或证据不匹配时不能继续假装现场存在。

工作区提交核对源目录的并发修改。冲突预览只是候选方案；真正应用时再次验证当前内容。人工确认或 Manager 建议必须对应当前恢复事实，不能重用过期批准。外部操作的未知结果需要核对，不能自动重放非幂等动作。取舍见 [ADR 0005](../adr/0005-workflow-recovery-evidence.md)。

## 验收场景

| 场景 | 应观察到的结果 | 主要测试入口 |
| --- | --- | --- |
| 修改已批准图 | 旧确认不再满足当前版本 | [激活测试](../../apps/main-2.0/src/automation/engine/main/hub/agent-hub-workflow-activation.test.ts) |
| 节点输出不满足约束 | 进入校验失败策略，不直接解锁成功路径 | [校验测试](../../apps/main-2.0/src/automation/engine/main/workflows/v2/workflow-v2-validation.test.ts) |
| strict 模式包含无约束外部脚本 | 执行前拒绝 | [工作区事务测试](../../apps/main-2.0/src/automation/engine/main/workflows/v2/workflow-v2-workspace-transaction.test.ts) |
| 用户在执行期间修改源文件 | 保留并发修改或报告冲突 | 同上 |
| 隔离目录消失后恢复 | 拒绝续跑，不创建假恢复结果 | 同上 |
| 恢复同图检查点 | 复用已接受结果，并保留运行证据 | [恢复测试](../../apps/main-2.0/src/automation/engine/main/workflows/v2/workflow-v2-recovery.test.ts) |

脚本沙箱、操作系统权限和外部服务自身的事务能力不由本文保证；新增外部效果必须明确接入执行授权与恢复策略。
