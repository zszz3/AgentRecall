# OpenViking 整 Session 导入与完整删除设计

## 目标

- 同一个 Agent Session 在一次扫描中只触发一次 OpenViking `commitSession`，避免按 10K Token 或 50 Turn 重复提取记忆。
- 删除受管目录时完整清理该 workspace；删除最后一个 workspace 时同时清除共享 OpenViking 运行数据，避免孤儿队列恢复执行。
- 保留已下载的 OpenViking Runtime 与本地嵌入模型。

## 导入边界

每次扫描先固定待导入快照。对每个发生变化的 Agent Session，收集扫描时已经完成、同时具备用户与助手文本、且尚未通过指纹检查点导入的全部 Turn。

这些 Turn 全部追加到同一个确定性 OpenViking Session，随后只调用一次 `commitSession`。不再按 Token 数或 Turn 数拆分任务。单个 Turn 继续沿用现有 12,000 字符截断，避免异常单条消息无限增长。

扫描和上传期间新增的 Turn 不进入当前快照，也不等待当前任务；下次扫描时，它们作为增量快照一次性提交。成功后按原有 Turn 指纹和 Session revision 写入检查点；失败时不推进检查点，重试复用同一个确定性任务边界。

多个 Agent Session 仍可按现有并发上限并行处理；同一个 Agent Session 只有一个导入任务。

## 删除流程

删除 workspace 时按以下顺序执行：

1. 标记该 workspace 不再接受新的导入推进，并让本地导入循环在安全边界退出。
2. 确保 OpenViking Runtime 可用，删除该 workspace 对应的远端用户空间。
3. 远端删除成功后，删除应用数据库中的 workspace、导入任务、检查点和本地凭证。
4. 如果仍有其他 workspace，保留共享 OpenViking Runtime 数据。
5. 如果删除的是最后一个 workspace，停止 Runtime，再清理 `openviking/data` 运行数据目录，包括队列、向量库和 `.ovgit`；保留 `runtime`、`models`、`downloads` 和安装清单。

若远端删除或本地运行数据清理失败，删除操作返回错误，不把失败伪装成成功。已完成的前序清理保持幂等，用户重试删除时可继续完成剩余步骤。

## 状态与界面

导入任务总数按 Agent Session 计数，不再按内部批次计数。现有 Turn 进度仍按成功写入检查点的 Turn 数推进。

删除成功后目录立即从列表消失；删除失败时保留目录或可重试状态，并显示具体错误。删除最后一个目录后，OpenViking Runtime 状态为停止，下一次添加目录时正常重新创建干净的数据目录。

## 测试

- 一个包含超过 50 Turn、超过 10K 估算 Token 的 Session 只生成一个导入任务，并只调用一次 `commitSession`。
- 导入途中新增 Turn 不进入当前快照，下次扫描作为增量提交。
- 多个 Session 各自单次提交，并保持跨 Session 并发。
- 删除活动导入的 workspace 后，本地循环不再推进。
- 删除非最后一个 workspace 不清理共享运行数据。
- 删除最后一个 workspace 时先停止 Runtime，再清理运行数据，同时保留 Runtime 和模型。
- 远端删除或运行数据清理失败时返回可重试错误，不报告虚假成功。
