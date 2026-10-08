# Eval 实验、判断与证据

范围：V2 Eval 服务和执行图。用户操作见 [V2 指南](../v2/guide.md)；本文包含服务层已有能力，不保证所有组合都在每个页面提供入口。

## 数据关系

| 对象 | 关键字段 | 用途 |
| --- | --- | --- |
| Dataset | id、items、时间戳 | 固定输入集合 |
| DatasetItem | id、input、expectedOutput、metadata、sequence | 一个 Case 的输入和顺序 |
| Evaluator | kind、threshold、enabled、dimension、subject | 判断规则和目标 |
| Experiment | datasetId、agentId、evaluatorIds、repetitions、source | 可重复的实验配置 |
| Run | experimentId、状态、结果、时间与版本信息 | 一次实际执行的记录 |

完整类型由 [evaluation/types](../../apps/main-2.0/src/automation/engine/shared/evaluation/types.ts)维护。实验可以关联 Skill、阶段定义、评分配置和自定义执行图；画布 layout 与图 spec 分开，布局不参与引擎语义。

## 产物来源

- `run_agent`：实际执行选定 Agent，取得输出及可解析的原生会话引用。
- `session`：读取已有会话产物，不因发起评估而重跑该会话。
- `folder`：读取目录产物；没有真实轨迹时不能虚构工具调用和 Token 消耗。
- 旧实验没有 source 时按 run_agent 解释；缺少阶段定义时仍评价完整运行，不凭空生成阶段。

会话关联依赖 Runtime 的明确 executionReference。没有接好 resolveSession/readTrajectory 时，轨迹评价不能通过猜测标题或最近一条会话来补齐。

## 判断器和评分

当前类型包含 contains、exact_match、json_valid、llm_judge、tool_failures、trajectory_budget、script。LLM Judge 需要有效的执行路由；实验执行 Agent 与 Judge 的职责分开。

同一维度内多个判断先汇总，再按实验评分配置组合；新增同维度判断不应悄悄增加该维度权重。预算未设置不同于预算为零；运行时没有报告指标，也不同于超支。脚本判断器故障要保留判断失败/无法评价的语义，不能直接把被评 Agent 记为零分。

阶段评价依赖真实轨迹边界和对应产物；无法定位阶段时保留未能追踪的原因，不拿整段输出冒充该阶段输出。评分、覆盖率、失败归因是不同信息。

## 执行接口与状态

[EvaluationService](../../apps/main-2.0/src/main/services/evaluation-service.ts)提供两类入口：

| 接口 | 返回时机 | 责任 |
| --- | --- | --- |
| runExperiment | 运行并保存结果后返回 Run | 前台等待调用仍由服务持有取消控制器 |
| startExperiment | running 行持久化后返回 runId | 后台执行，按进度更新持久化记录 |
| cancelRun | 向活动运行发出 abort | 协作取消，不代表返回瞬间底层进程已经结束 |
| close | 标记关闭、取消并等待活动执行 | 不能先关闭 store 再让后台任务继续写入 |

后台开始前先验证实验依赖；验证失败不应留下伪 running 记录。后台异常由所属运行记录承接。返回 runId 只证明运行已登记，不代表评分完成。

## Skill 和数据集版本

绑定 Skill 的实验读取实际 SKILL.md 内容及 hash，结果应归属本次执行的版本，而不是运行后当前磁盘文件。实验关联和 Agent 删除引用检查需要一致，不能删除仍被实验使用的 Agent 后静默选用其他 Agent。

目录数据集导入通过原生目录选择器授权。目录身份决定更新目标，同目录重复导入更新同一数据集；没有读到任何有效 Case 时拒绝导入，部分读取错误需要保留报告。

## 验收场景

| 场景 | 期望结果 |
| --- | --- |
| 数据集已被删除 | 执行前失败，不创建假成功 Run |
| Judge 没有可用执行 Agent | 明确报告配置问题 |
| 后台执行启动 | 先可查询到 running 行，再返回 runId |
| 运行中取消 | 活动执行收到信号，最终结果保留取消状态 |
| 应用关闭时仍有执行 | 等待执行清理后关闭持久化资源 |
| 目录产物没有轨迹 | 轨迹判断保留不适用/证据缺失语义 |
| 判断脚本错误或超时 | 区分判断器故障与被评 Agent 的质量问题 |
| 同一维度增加检查 | 不因数量变化意外增加维度权重 |

## 实现与验证

- [服务测试](../../apps/main-2.0/src/main/services/evaluation-service.test.ts)：依赖校验、后台运行、取消和关闭。
- [评分器](../../apps/main-2.0/src/core/evaluation/graph/scorer.ts)及[测试](../../apps/main-2.0/src/core/evaluation/graph/scorer.test.ts)：维度与评分聚合。
- [判断脚本](../../apps/main-2.0/src/core/evaluation/judge-script-runner.ts)及[测试](../../apps/main-2.0/src/core/evaluation/judge-script-runner.test.ts)：脚本执行边界。
- [数据集目录](../../apps/main-2.0/src/core/evaluation/dataset-folder-io.ts)：原生授权后的磁盘读写。

评估结果只对使用的数据、版本和执行条件成立。配置了评估器或图节点不等于有真实模型运行证据；服务单测也不替代真实任务效果评估。
