# 阶段一：Skill 触发与会话的关联地基

状态：已实现，待合并（合并后在此回填 PR 链接）。

## 1. 目标与非目标

**目标**：交付 Eval 开关与数据地基：开启后，每条新的 Skill 触发事件能够解析
到它所发生的已索引会话（session 级必达，turn 级尽力而为），使审计侧（阶
段二）与回归侧（后续阶段）能从索引库消费真实表现数据。

**非目标**：

- 不做任何审计指标计算与报告 UI（阶段二）；
- 不做回归执行器、用例、grader（后续阶段）；
- 不为历史无关联键的事件做时间窗猜测归因；
- 不在 hook 中采集 token、时长、工具轨迹等重数据（索引库已持有）；
- 不改动 V1 任何代码。

## 2. 现状事实（基于当前代码核查）

| 事实 | 位置 |
| --- | --- |
| Claude 转录不记录 Skill 调用，PostToolUse hook 是唯一可靠来源 | `bin/skill-usage-record.cjs` 头注释 |
| hook 记录当前仅有 `{skill, agent, event, ts}` 四字段 | `bin/skill-usage-record.cjs` 的 `buildRecord` |
| Claude PostToolUse stdin 携带 `session_id`、`transcript_path`、`cwd`，当前被丢弃 | Claude Code hooks 契约 |
| `skill_usage_events` 列为 `(source_path, event_index, agent, skill, occurred_at)`，无会话关联 | `src/core/postgres/schema.ts` v1 迁移 |
| 事件入库为按 source 删全量重插 | `PostgresSkillRepository.upsertSkillUsageSource` |
| Codex 事件的 `source_path` 即会话 jsonl 文件路径 | `src/core/skill-usage.ts` 头注释 |
| Claude 会话 `raw_id` = 转录文件名去掉 `.jsonl`，与 hook 的 `session_id` 同源 | `src/core/session-loader.ts` |
| 最新 Postgres 迁移版本为 11 | `src/core/postgres/schema.ts` |
| hook 注册的是指向 `bin/skill-usage-record.cjs` 的命令路径，应用更新即脚本更新 | `bin/setup-skill-usage-hook.cjs` |
| usage hook 现状即为手动可选安装（`SkillService.installUsageHook / uninstallUsageHook / getUsageHookStatus`），无启动时自动注册 | `src/main/services/skill-service.ts` |
| `openVikingMemoryEnabled` 为默认关闭开关 + 服务层 `requireEnabled()` 门禁的现成模式 | `src/core/platform.ts`、`src/main/services/openviking-control-service.ts` |

## 3. 设计

### 3.0 Eval 开关（仅 V2）

新增应用设置 `evalEnabled: boolean`，默认 `false`，完全对齐
`openVikingMemoryEnabled` 的模式：

- 设置页新增 Eval 区块：开关 + 启用引导（提示需安装 usage hook，提供一键
  安装按钮，复用现有 `SkillService.installUsageHook`）；
- 开启时触发一次 hook （重）安装，确保生效脚本为 V2 版本（从而开始采集
  `session_id`）；
- 未开启时：不做关联解析，Eval 页展示启用引导空状态（OpenViking Memory
  页的 `requireEnabled()` 门禁模式）；
- hook 脚本本身保持无配置哑脚本：只要被调用且 stdin 携带 `session_id`，
  就写入该字段（本地文件、用户自有数据，无隐私外泄面）。

### 3.1 Hook 记录扩展（仅 V2 的 bin 脚本）

`apps/main-2.0/bin/skill-usage-record.cjs` 的 `buildRecord` 在现有四字段之外
追加：

| 新字段 | 来源 | 说明 |
| --- | --- | --- |
| `session_id` | stdin 的 `input.session_id` | 字符串校验，缺失则省略字段 |
| `cwd` | stdin 的 `input.cwd` | 项目归属校验用，缺失则省略 |

V1 边界：V1 与 V2 的 hook 写同一个 `~/.claude/skill-usage.jsonl`，谁后注册谁
生效。**V1 代码不改**：开启 Eval 时 V2 重新注册即保证生效脚本是 V2 版本；用
户此后若从 V1 重装 hook，后续记录无 `session_id`，在解析层自然退化为
`unlinked`，不报错不猜测。V1 的解析器对未知字段天然忽略（实现时以 V1 现有
测试全绿确认，不新增 V1 测试）。

### 3.2 解析层扩展（仅 V2）

`src/core/skill-usage.ts`：

- `SkillUsageEvent` 增加可选字段 `sessionId?: string`、`cwd?: string`；
- `claude-hook` 分支读取记录中的 `session_id` / `cwd`；
- `codex-session` 分支不变（不伪造 sessionId，关联走 `source_path`）。

### 3.3 存储扩展（仅 V2，迁移 v12）

```sql
ALTER TABLE agent_recall.skill_usage_events
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS cwd text;

CREATE INDEX IF NOT EXISTS skill_usage_events_session_idx
  ON agent_recall.skill_usage_events (session_id)
  WHERE session_id IS NOT NULL;
```

`PostgresSkillRepository.upsertSkillUsageSource` 的 insert 增加两列。
`getSkillUsageSnapshot` 等聚合查询不变。

不加外键：hook 事件可能先于会话被索引到达，也可能引用从未被索引的会话；
关联在查询期解析而非写入期物化，会话晚到时自然补全，无需回填任务。

### 3.4 关联解析规则（查询期）

| 来源 | 解析路径 | 约束 |
| --- | --- | --- |
| `claude-hook` 事件 | `session_id` → `sessions.raw_id`（限 `source = 'claude'` 且本地存储环境） | 多环境可能出现 raw_id 撞车，本阶段仅解析本地环境 |
| `codex-session` 事件 | `source_path` → `sessions.file_path` | 已天然成立 |
| turn 级解析 | `occurred_at` 落入 `session_turns.[started_at, ended_at]` 区间 | 尽力而为：区间缺失或不命中时回退为 session 级，不强行归属 |

解析结果分三档，供上层如实展示：

- `linked-turn`：解析到具体 turn；
- `linked-session`：仅解析到会话；
- `unlinked`：无关联键（历史事件）或键无法命中——只进总量统计，不进表现分析。

### 3.5 最小可见面（随本阶段交付）

本阶段的用户可见面 = 设置页的 Eval 开关 + Eval 页的最小骨架：未开启时为
启用引导空状态；开启后按评测对象维度展示 Skill 列表，每个 Skill 可查看最
近触发及其关联会话（标题 + 时间，点击跳转会话详情；无关联显示"未关联"）。
这既满足"每个分支恰好一条用户可见 release note"的仓库约定，也端到端验证
关联链路。Eval 页的完整信息架构（实况卡片、findings、回归运行）在阶段二
及后续阶段文档中定义。

## 4. 测试计划

全部使用临时 HOME 与合成 fixture，不触碰真实用户数据（遵守 AGENTS.md 安全
规约）：

- `buildRecord`（仅 V2）：含/缺 `session_id`、`cwd` 的 stdin 载荷；非 Skill
  工具仍返回 null；
- 设置层：`evalEnabled` 默认 false；开关门禁生效（未开启时解析器不工作）；
- 解析层：新旧两代 jsonl 记录混合解析，旧记录字段为 undefined；
- 存储层（PGlite）：v12 迁移幂等；新列随 upsert 落库；删插后旧事件仍可查；
- 解析器：claude raw_id 命中、codex file_path 命中、撞不上时保持 unlinked、
  turn 区间命中与回退；
- V1 回归：`test:v1` 全绿，确认 V1 在零改动下对新字段记录无感知。

## 5. 验收标准

1. 设置中可开启 Eval（默认关闭），开启流程引导完成 hook 安装；未开启时
Eval 页为启用引导空状态；
2. 开启后，新的 Claude Skill 触发事件带 `session_id` 落库，且能在 Eval 页看
到关联会话；
3. 既有 Codex 事件通过 `source_path` join 解析出会话，无需数据变更；
4. 历史无键事件保持可查、明确标注"未关联"，不参与表现分析；
5. `npm run test:v1`、`npm run test:v2` 全绿，且 V1 目录零改动。

## 6. 风险与开放问题

- **Claude hook 载荷契约漂移**：`session_id` 字段名以 Claude Code 实际 stdin
  为准，实现时以真实载荷样本验证后再定死解析逻辑；
- **远程环境会话**：远程同步来的 Claude 会话与本地 hook 事件的关联不在本阶
  段范围（hook 只在本地触发，远程会话关联留待有真实需求时设计）；
- **CodeBuddy / Qoder / Trae 来源**：类型上已存在但当前无采集来源，本阶段不
  扩展。
