# 阶段二：Skill 实况报告（审计侧最小版）

状态：已实现，待合并（合并后在此回填 PR 链接）。

## 1. 目标与非目标

**目标**：点亮 Eval 页 Skills tab 的审计侧第一段——左侧列表健康 badge 与右
侧实况卡片，让用户看到每个 Skill 的真实触发情况、基础表现信号与版本切分，
全部结论带证据强度标注。

**非目标**：

- 不做 Findings 段（结构化 finding + 修复建议，阶段三）；
- 不做 Skills 页迷你评测 badge（双向入口，阶段三）；
- 不做版本对比 UI（回归侧配套时一起做）；
- 不做 trace_spans 重试模式挖掘（启发式易误报，推后）；
- 不做"触发后用户重复类似请求"类语义信号（伪 Outcome 归因，违反证据阶
  梯，永久不做）；
- 不打质量分、不排名——阶段二只呈现描述性事实。

## 2. 现状事实（基于当前代码核查）

| 事实 | 位置 |
| --- | --- |
| hook 记录已有 `{skill, agent, event, ts, session_id?, cwd?}` | `bin/skill-usage-record.cjs`（阶段一） |
| `skill_usage_events` 已有 `session_id`/`cwd` 可空列（迁移 v12） | `src/core/postgres/schema.ts` |
| `listRecentSkillTriggers` 已能解析三档关联 | `src/core/postgres/skill-repository.ts` |
| `session_turns` 持有 token 五档、起止时间、`error_count`、`tool_names` | schema 建表语句 |
| `skill_sync_bindings` 只存最新版 `remote_version`/`last_content_hash`，无历史 | schema 建表语句 |
| `skillSyncContentHash` 遍历 skill 目录全部文件做 sha256 | `src/core/skill-sync.ts` |
| 已装 Skill 扫描覆盖用户级/项目级/plugins 多根目录 | `src/core/skill-manager.ts` |

## 3. 版本关联键：hook 加采 `skill_hash`

### 3.1 为什么不与 sync 侧 hash 同源

`skill_sync_bindings` 无版本历史，任何 hash 都映射不回历史版本号，"同源"
没有收益。版本切分的本质是**按 hash 分组**：hash 只需自身稳定。同时
`skillSyncContentHash` 需遍历目录全部文件，对 "never disrupt the host" 的
hook 过重，且零依赖 CJS 复刻该算法会形成两处维护。

### 3.2 采集设计

hook `buildRecord` 新增可选字段 `skill_hash`：

- 定位 `SKILL.md`：先 `<cwd>/.claude/skills/<skill>/SKILL.md`，后
  `~/.claude/skills/<skill>/SKILL.md`（与 Claude 项目级优先的解析顺序一
  致）；plugin skill 与找不到文件的情况直接省略字段；
- 值为该文件内容的 sha256 hex（全长 64 字符）；
- 读取失败静默省略——hook 铁律不变：任何失败吞掉并 exit 0；
- 只读单文件，不遍历目录；只改 assets 不换 hash 属可接受盲区（Skill 行为
  主体是 SKILL.md）。

应用侧对已安装 Skill 的 SKILL.md 用同一不变式（对文件原始字节做 sha256）
计算"当前版本"哈希。hook 侧函数按名字加 cwd 自行定位文件、应用侧直接读已
知路径，两处签名不同不强行合一，以双向交叉注释锁定同一哈希不变式。

### 3.3 数据落地

- 解析层 `SkillUsageEvent` 加可选 `skillHash`；
- 迁移 v13：`skill_usage_events` 加 `skill_hash text` 可空列；
- 历史事件无 hash → 版本切分中归入 `version unknown` 组，与 unlinked 的
  处理哲学一致，不做猜测归因。

## 4. 实况报告的四层内容

### 4.1 触发层统计（per skill）

- 总触发次数、最近触发时间；
- 近 7 天 / 30 天触发次数（趋势）；
- 关联率：linked（turn 或 session）事件占比。

### 4.2 已装未用清单（Present but never Exercised）

已安装 Skill（`skill-manager` 扫描结果）与触发记录求差集。措辞边界：

- Eval 刚开启或 hook 未安装期间的"没有记录"必须显示为
  **Unobserved（观测不到）**，不得写成"没用过"；
- 判定规则：hook 当前未安装，或该 Skill 安装时间晚于最早触发记录窗口且
  无任何事件来源覆盖它时，显示 Unobserved 而非 never-used 警示。
  实现上以"hook 已安装且全库已存在任何 claude-hook 事件"作为 claude 侧
  可观测的最低门槛；codex 侧凭会话文件扫描天然可观测。

### 4.3 表现层启发式信号（仅 linked-turn 事件，三个纯 SQL 信号）

| 信号 | 计算 | 参照 |
| --- | --- | --- |
| 触发 turn token 消耗 | 该 Skill 全部 linked-turn 触发 turn 的 `total_tokens` 中位数 | 全库非合成 turn 的中位数 |
| 触发 turn 时长 | `ended_at - started_at` 中位数（缺时间戳的 turn 不计入） | 同上 |
| 触发 turn 错误占比 | `error_count > 0` 的触发 turn 占比 | 全库非合成 turn 错误占比 |

呈现纪律：

- 每个信号旁标注证据强度 `Exercised` 与样本量（n=X 次 linked-turn 触发）；
- 样本量 < 3 时显示"样本不足"，不显示数值；
- 全部是描述性事实（"触发 turn 中位耗 2.1 万 token，全库中位 0.8 万"），
  不换算成任何分数。

### 4.4 版本层切分

- 按 `skill_hash` 分组显示各组的触发次数与时间范围；
- 应用侧现算当前 hash，命中的组标注"当前版本"；有 sync binding 的 Skill
  同时显示 `remote_version`（仅作为当前版本号展示，不参与历史切分）；
- 无 hash 的历史事件归入 `version unknown` 组。

## 5. 改动面

| 层 | 改动 |
| --- | --- |
| Hook | `bin/skill-usage-record.cjs`：`buildRecord` 加 `skill_hash`（导出 hash 函数供 core 复用） |
| 解析 | `src/core/skill-usage.ts`：`SkillUsageEvent.skillHash` 可选字段 |
| Schema | 迁移 v13：`skill_usage_events.skill_hash text` 可空列 |
| 查询 | `skill-repository.ts`：新增实况聚合查询（触发层统计 + 表现层三信号 + 版本分组），继续沿用查询期解析、不物化 |
| 服务 | `SkillService` 新增实况报告方法（`evalEnabled` 门禁，模式同 `listSkillTriggers`）；组合 `skill-manager` 扫描结果得出已装未用/Unobserved |
| IPC | `SKILLS_IPC` 新增实况报告通道（shared 契约 → main 注册 → preload） |
| UI | `features/eval/eval-page.tsx`：左列表加健康 badge（触发数/趋势/never-used/Unobserved），右侧详情实况卡片三块（触发统计、表现信号、版本切分）；空态措辞区分 Unobserved 与零触发 |

V1 零改动。不新增表，只加一列。

## 6. 测试计划

- hook：`skill_hash` 采集（临时 HOME + 合成 SKILL.md 夹具，项目级优先、
  缺文件省略字段）；
- 解析层：新旧记录混合解析，`skillHash` 可选透传；
- repository：实况聚合查询（PGlite）——触发统计、三信号中位数/占比、版本
  分组、样本不足档、合成 turn 排除；
- service：`evalEnabled` 门禁 + 已装未用/Unobserved 判定分支；
- 全部测试用临时 `HOME` 与合成夹具，不触真实用户数据。

## 7. 验收标准

1. 开启 Eval 并安装 hook 后，新触发记录带 `skill_hash`；
2. Eval 页 Skills 列表显示健康 badge；选中 Skill 显示实况卡片三块；
3. 表现层信号均带 `Exercised` 标注与样本量，样本 < 3 显示样本不足；
4. hook 未安装时相关区域显示 Unobserved 而非"没用过"；
5. 历史无 hash / 无关联键事件如实归入 unknown / unlinked，不猜测；
6. `test:v1`、`test:v2`、`release-note:check` 全绿，V1 零改动。

## 8. 风险与开放问题

- **hook 性能**：每次触发多一次单文件读 + sha256，SKILL.md 通常 < 100KB，
  可忽略；仍保留静默失败兜底；
- **skill 名与目录名不一致**：`tool_input` 里的 skill 名可能与目录名有大小
  写或格式差异，定位失败时省略字段即优雅降级，不阻塞记录本身；
- **全库中位数基线的语义**：混合了所有来源/项目的 turn，作为粗参照可用；
  更精细的"同项目基线"留到有真实使用反馈后再决定是否收窄。
