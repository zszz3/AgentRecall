# V2 性能检查与优化顺序

## 当前已处理的开销

会话增量索引保留未变化的历史记录；Codex 标题元数据更新不再使所有会话正文失效。这项修复已通过 [PR #588](https://github.com/zszz3/AgentRecall/pull/588) 进入 main，并同步到团队开发分支。

V2 工作台的每日 Token 趋势在数据库中完成去重和按天聚合，每次最多返回 7、30 或 90 行。日历边界由客户端以绝对时间传入，保持本地时区、夏令时、起始日和当前时刻的原有语义。该优化不改变会话记录、不建立额外缓存，也不改变统计结果。V1 没有这套 `dailyHistoryDays` 工作台接口，本次不改动其 SQLite 统计。

可拖动侧栏将同一帧内的尺寸通知合并到下一帧处理，避免在 ResizeObserver 的布局通知阶段立即改变网格；组件卸载时取消待处理帧和拖动监听。键盘调整、拖动、宽度记忆及窄窗口堆叠行为保持原有约定。

## 测量范围

2026-09-28，在隔离 HOME 内使用内存 PGlite 和 50,000 条合成 Token 事件，对比修改前后的 `getStats({ period: "allTime", dailyHistoryDays: 90 })`。预热一次，交替执行修改前后实现各五次，统计整次方法调用的中位耗时、所有数据库查询返回行数及其 JSON 字节数；每次验证 Token 总量为 250,000。数据库和进程在完成后关闭，未将个人会话用于测试。

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 单次查询最多返回行数 | 50,000 | 90 |
| 整次方法返回的数据库行数 | 50,003 | 93 |
| 整次方法查询结果的 JSON 大小 | 8,950,272 字节 | 16,192 字节 |
| 方法调用中位耗时 | 315.9 ms | 122.9 ms |

这是合成数据、内存 PostgreSQL 兼容引擎的局部对比，不是完整应用启动时间或生产 PostgreSQL 的性能承诺。真实收益还受数据分布、磁盘、并发索引和查询计划影响。现有测试同时覆盖 7/30/90 天、重复事件、空日期补零、不同来源、上海时区及纽约夏令时切换。

## 下一步优先级

| 顺序 | 源码观察 | 建议实施与验收 |
| --- | --- | --- |
| 1 | 长会话的 Turn 列表仍遍历并渲染所有摘要，展开的轨迹也直接渲染整组条目 | 先记录 1,000/10,000 Turn 的打开、展开和滚动长任务，再为列表增加窗口化；必须保留会话内查找定位、展开状态和键盘访问。不能靠截断持久化内容提速。 |
| 2 | 索引仍包含同步目录遍历、文件头读取，以及历史内容的合并与派生 | 分开测量扫描、解析、派生、数据库写入时间，再将重计算移到有取消和关闭机制的 Worker。Codex 首行提示当前单次读取最多 256 KiB，可先评估按需分块读取；这项公共加载器优化应同时覆盖 V1/V2。 |
| 3 | 工作台 Hook 常驻 App，额度和活动状态定时更新；索引完成会刷新统计、侧栏和工作台会话 | 让未显示的工作台数据按需更新，并合并并发请求；仍保留 Session 页面依赖的活动状态，重新显示时刷新。先用请求计数验证减少了无用工作，再测 CPU。 |
| 4 | 搜索页同时计算总数、来源计数及其他筛选统计；通用趋势接口仍返回事件后分桶 | 采集慢查询和真实查询计划，再判断是否分离计数、按变更失效缓存或在 SQL 中聚合。不要凭感觉添加索引或长期缓存。 |

表中的四项仍是源码审查得出的候选项，不代表已测得各自耗时，也不代表已实现。当前空闲进程的一次 CPU 采样约为 0.5%，因此不能把所有卡顿都解释为持续后台占用；下一轮要重点记录具体操作时的峰值与响应延迟。

## 维护位置

- 每日统计：[PostgresSessionStatsRepository](../../apps/main-2.0/src/core/postgres/session-stats-repository.ts)，回归在同目录的 `session-repository.test.ts`。
- 尺寸更新：[ResizableSplit](../../apps/main-2.0/src/renderer/src/components/resizable-split.tsx)，回归在同目录的 `resizable-split.test.tsx`。
- 长会话：[TurnAccordion](../../apps/main-2.0/src/renderer/src/features/session-detail/turn-accordion.tsx)。
- 页面刷新：[useWorkbenchOverview](../../apps/main-2.0/src/renderer/src/features/workbench/use-workbench-overview.ts)。

数据库按有序时间边界分桶使用 PostgreSQL 的 [`width_bucket`](https://www.postgresql.org/docs/current/functions-math.html)，不依赖数据库服务器的默认时区。
