# Eval 总览

## 1. 文档定位

本文是 AgentRecall V2（`apps/main-2.0`）Eval 能力的总体设计。首发评测对象为
Skill，后续按同一框架扩展到 Workflow、Rules 等资产。本文定义评测对象、范式
整合方式、核心设计原则、术语和分期边界；各阶段的实现要求见对应的 phase 文
档，随迭代持续补充并回填 PR 链接：

- [阶段一：Skill 触发与会话的关联地基](./phase-01-skill-session-linkage.md)（已合并，[PR #246](https://github.com/zszz3/AgentRecall/pull/246)）
- [阶段二：Skill 实况报告（审计侧最小版）](./phase-02-skill-live-report.md)（设计中）
- 后续阶段：回归执行器、用例挖掘、报告与对比——待设计

Eval 能力只在 V2 交付，且为**默认关闭的可选功能**：设置中提供 Eval 开关
（对齐 OpenViking Memory 的启用模式），开启后引导完成 hook 配置，未开启时
不做任何数据关联与分析。V1 代码不做改动。

## 2. 评测对象：用户能改动的资产

AgentRecall 的 runtime 对接的都是主流通用 Agent（Claude Code、Codex、
OpenCode 等）。模型不是我们训练的，Harness 不是我们编写的，评测它们得出的
结论用户无法付诸行动。因此 Eval 的自变量不是 model 或 harness，而是
**用户手里能改、经常改、容易改坏的资产**：

| 资产 | 处置 |
| --- | --- |
| Skill | **首发评测对象**（本文档系列的主线） |
| Workflow 定义 | 第二优先级。Workflow V2 已内置节点级验收，Eval 补充的是跨 revision 的横向对比；单次运行成本高，待 Skill 侧基础设施稳定后接入 |
| MCP 配置 | 不作为独立评测对象。"工具选择是否正确"降级为一种轨迹层 grader 维度，供 Skill / Workflow 评测复用 |
| Rules / agent instructions | 暂不排期，但与 Skill 在数据模型上同构（文本资产 + 版本 + 绑定 runtime 执行），表结构按通用 versioned artifact 预留 |
| Chat 房间编排 | 不排期。多 Agent 协作质量的评分难度最高，且形态仍在快速演进 |

由此产生本设计的范式基点：

```text
ClawBench 范式：   固定 Harness，变 Model      → 回答"选谁"
HarnessBench 范式：固定 Model，变 Harness      → 回答"选谁"
AgentRecall 范式： 固定 Model + Harness，变资产版本 → 回答"我这次改动是变好还是变坏"
```

Model 与 Harness 是**需要控制的实验环境变量**。它们每周都在更新且用户躲不
掉，因此同一套评测定期重跑即是环境漂移监测——漂移监测与资产迭代验证共用同
一套基础设施，不单独立项。

## 3. 三范式整合

Eval 由三种互补范式组成一条接力链，整合在同一套系统内：

| 范式 | 数据来源 | 成本 | 回答的问题 |
| --- | --- | --- | --- |
| 审计 | 已索引的真实会话，零合成任务 | 几乎免费（只读库） | 真实工作中哪里出了问题、该修谁 |
| 回归 | 固定 eval 用例集，主动执行 | 花费用户 token | 这次改动变好还是变坏 |
| 考试 | 更大规模用例集，定期跑批 | 最高 | 整体水平提升了多少 |

```text
审计（复盘真实会话）→ 发现问题 → 用户修改资产
→ 回归（重跑固定用例）→ 确认修好且未改坏
→ 考试（定期大集跑批）→ 量化长期趋势
```

交付顺序：先审计（用已有数据、零 token 成本、立即产出价值），后回归/考试
（依赖审计侧建成的数据地基）。

## 4. 核心设计原则

1. **Hook 只采关联键，重数据来自索引库。** AgentRecall 的会话索引库已持有
   turn 级起止时间与 token 五档、trace_spans 级工具调用全量输入输出与时间
   戳、token_events 逐事件流水。评测不自建采集管道，hook 只补"触发事件 ↔
   会话"的一把钥匙。
2. **证据阶梯是一等公民。** 每条评测结论标注证据强度：
   `Present（已配置）→ Exercised（真实使用过）→ Outcome-supported（有后续
   可比结果支撑）`，以及 `Missing / Unobserved（观测不到就明说）`。
   配置了 ≠ 用了；触发了 ≠ 有帮助。观测边界不足时保持 Unobserved，
   不编造分数，不做无证据的因果归因。
3. **同窗证据 ≠ 跨窗证据。** 修改资产后当场通过回归只证明"修了"；只有后续
   真实使用或可比评测的结果才能证明"变好了"。报告措辞按此区分。
4. **versioned artifact 抽象。** 受测资产统一建模为
   `{type, identity, version, content_hash}`；第一期只实现 `skill`，
   Rules / Workflow 后续进场不做表结构迁移。
5. **自进化边界。** 本设计范围内 Eval 只产出结构化的失败分析与报告，
   不生成补丁、不自动修改任何资产。自进化闭环的后半段（改进建议、自动修
   改）不在当前范围，未来若引入必须以扎实的回归 eval 兜底为前提。
6. **执行成本有闸。** 回归/考试侧真实调用用户自己的账号与配额，执行器必须
   具备 token 预算上限、并发控制、进度上报与取消能力。

## 5. 与现有 evaluation 骨架的关系

V2 已存在一套 `evaluation_*` 表与 Dataset / Evaluator / Experiment / Run
四层模型（prompt → 跑 configured agent → 文本打分）。处置原则：

- Dataset / Evaluator 的骨架保留并扩展（新增轨迹层 grader、证据状态字段）；
- Experiment 需从"绑定 agentId"改造为"绑定受测 artifact + 固定执行环境
  （runtime + model）"，这是范式基点在数据模型上的落点；
- 现有 runner 为一次性同步串行执行，回归侧接入时重写为带生命周期状态机的
  执行器；
- 空壳表 `evaluation_subjects`（session / turn / span 三种主体）由审计侧
  填活。

具体改造在回归侧 phase 文档中给出，不在阶段一范围内。

## 6. Eval 页信息架构

Eval 页采用**对象视角**而非机械件视角：用户进入时回答的问题是"我的资产们
表现怎么样"，而不是"管理数据集与实验"。

- 顶部按评测对象类型分 tab：Skills（首发）、Workflows、Rules（后两者从第
  一天起即展示为锁定态，立住"通用资产评测"叙事）；
- 左侧对象列表自带健康信号 badge（触发次数/趋势、长期未用警示、上次评测
  结果），列表本身即体检总表；
- 右侧详情为三段式，与三范式一一映射：实况卡片（审计）→ Findings（审
  计产出）→ 评测运行（回归，含用例/运行历史/版本对比），分阶段逐段点
  亮，布局不推翻；
- 无选中对象时展示总览 dashboard（已装未用清单、退化告警、最近触发动态）；
- Dataset / Evaluator 等机械件降级为"评测运行"段落内的二级配置入口，不占
  一级导航；
- Skills 页每个技能附迷你评测摘要 badge，点击跳转 Eval 页对应对象（数据同
  源，入口双向）。

## 7. 当前实现边界

阶段一已合并（[PR #246](https://github.com/zszz3/AgentRecall/pull/246)）：

- Eval 为设置中默认关闭的开关；开启时若 usage hook 已安装会先卸后装，
  确保生效脚本为 V2 版本；
- Claude hook 记录新增 `session_id`/`cwd`；`skill_usage_events` 新增同名可空
  列（迁移 v12）；
- 关联在查询期解析：claude-hook 事件走 `session_id → sessions.raw_id`
  （限本地存储环境），会话文件扫描出的事件走 `source_path →
  sessions.file_path`（含 Codex、Cursor、Qoder 等全部会话文件来源），
  turn 级按时间区间尽力解析；三档结果 linked-turn / linked-session /
  unlinked，历史无键事件保持 unlinked；
- Eval 页为对象视角最小骨架：Skills tab（触发列表 + 关联会话跳转）、
  Experiments tab（原有实验功能）、Workflows/Rules 锁定态；
- 审计指标、findings、回归执行器均未实现（阶段二及后续）。

## 8. 决策记录

| 决策 | 被淘汰的备选 | 理由 |
| --- | --- | --- |
| 评测对象 = 用户可改动资产 | 评测 model / harness 能力（ClawBench、HarnessBench 式） | 评测结论要能驱动迭代；model 和 harness 用户改不了 |
| Skill 首发 | Workflow / Chat / MCP 首发 | Skill 是用户改动最频繁、最易改坏的资产；AgentRecall 已有 Skill 管理、版本同步、usage hooks、会话轨迹库四项既有资产可直接复用；单次评测成本最低 |
| 三范式整合为一套系统 | 只做其中一种；审计范式让位给外部工具 | 审计→回归→考试是接力关系而非竞争关系；AgentRecall 的会话索引库同时是审计证据源和用例挖掘源，整合收益最大 |
| Claude 侧关联走 hook 加字段 | 从已索引轨迹识别 Skill 调用 | 上游已验证 Claude 转录不记录 Skill 调用（见 `bin/skill-usage-record.cjs` 头注释），轨迹识别路线对 Claude 不成立；Codex 侧 `source_path` 即会话文件路径，天然可 join，无需改动 |
| hook 改动仅在 V2，Eval 为默认关闭的开关功能 | V1/V2 双写 hook 脚本 | Eval 是 V2 独有功能，hook 字段扩展只服务 Eval；开启 Eval 时 V2 重新注册 hook 即可保证生效脚本是 V2 版本；用户此后若从 V1 重装 hook，新记录退化为未关联，属可接受的优雅降级 |
| 历史无关联键事件不做时间窗猜测归因 | 按时间戳弱匹配到会话 | 假关联污染审计结论，违背证据阶梯原则；旧事件标记未关联，仅进总量统计 |
| 评测数据不物化进 hook 采集 | 材料调研中出现的"hook 采集全量执行数据"方案 | 该方案适用于没有会话索引库的场景；AgentRecall 的索引库已持有全部所需数据，重复采集冗余且只对未来生效 |
| 版本关联键 = hook 触发时只读 SKILL.md 算 sha256 | 复刻 sync 侧全目录 content hash；阶段二不采版本键 | `skill_sync_bindings` 无版本历史，同源 hash 映射不回版本号，切分只需 hash 自身稳定；全目录遍历对 hook 过重且形成算法两处维护；越早开始采，版本切分数据越早可用 |
| 表现层只做三个纯 SQL 描述性信号（token/时长/错误占比），不打分不排名 | trace_spans 重试模式挖掘；"触发后重复请求"语义信号 | 重试启发式易误报推后；语义信号是伪 Outcome 归因，违反证据阶梯，永久不做 |
