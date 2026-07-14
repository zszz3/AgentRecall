# Star History 仓库内快照设计

## 背景

`Update Star History` workflow 当前通过 `/repos/{owner}/{repo}/stargazers` 获取每个 Stargazer 的时间戳。GitHub 自 2026-06-30 起逐步限制该接口，Actions 自动生成的 `GITHUB_TOKEN` 已返回 403，导致图表生成在 commit/push 之前失败。

修复不引入 PAT、额外 GitHub App 或第三方图表服务，也不保存 Stargazer 身份。仓库只保留生成图表所需的每日 Star 数量。

## 数据模型

新增 `assets/star-history-data.json`：

```json
{
  "repository": "zszz3/agent-session-search",
  "snapshots": [
    { "date": "2026-06-01", "count": 1 },
    { "date": "2026-06-02", "count": 1 }
  ]
}
```

- `repository` 必须是当前 `GITHUB_REPOSITORY`。
- `date` 使用 UTC `YYYY-MM-DD`，严格升序且不能重复。
- `count` 是非负整数，表示该日观察到的仓库 Star 总数。
- 快照允许下降，以反映用户取消 Star 后的真实总数。
- 文件不包含用户名、用户 ID、Star 明细或访问凭证。

首个版本由协作者在本地读取一次现有 Stargazer 时间戳，聚合为每日历史基线并提交。该一次性动作只用于初始化 JSON；workflow 不再调用受限接口。

## 运行时数据流

1. 读取并校验 `assets/star-history-data.json`。
2. 请求 `GET /repos/{owner}/{repo}`，读取公开 metadata 中的 `stargazers_count`。workflow 继续使用 `GITHUB_TOKEN` 获取常规 API 限额，但只访问 metadata 接口。
3. 以当前 UTC 日期更新快照：
   - 已有当天记录时，用最新数量覆盖。
   - 缺少当天记录时，从最后日期到昨天补齐记录，沿用最后已知数量，再写入当天数量。
   - API 数量与当天快照相同时不改文件。
4. 使用快照直接生成 `assets/star-history.svg`。
5. JSON 或 SVG 任一变化时，workflow 同时 add 并提交两个文件；均无变化时正常退出。

图表继续显示 `Star History`，描述文本改为 Star count history，不再声称数据始终单调累计。

## 组件边界

`scripts/generate-star-history.mjs` 保留渲染职责，并拆出以下可测试边界：

- `fetchStarCount({ repository, token, fetchImpl })`：只读取仓库 metadata 并验证 `stargazers_count`。
- `parseStarHistoryData(value, repository)`：验证仓库标识、日期、顺序和数量。
- `updateDailySnapshots(snapshots, date, count)`：纯函数，处理同日覆盖与日期补齐。
- `renderStarHistorySvg({ repository, series })`：从快照渲染确定性 SVG。
- `main()`：编排读取、请求、更新及两个产物的幂等写入。

不新增运行时依赖。

## 失败处理

- metadata 请求非 2xx：输出状态码及截断后的响应正文，退出非零。
- metadata JSON 无效或缺少非负整数 `stargazers_count`：给出明确错误，退出非零。
- 快照文件缺失、仓库不匹配、日期非法、顺序错误或数量非法：拒绝覆盖现有产物，退出非零。
- API 请求失败时不使用旧数量伪装成功，避免图表静默停更。

## 测试与验收

脚本测试采用 TDD 覆盖：

- metadata 请求路径、认证头与 `stargazers_count` 解析。
- 403、畸形 JSON、缺失或非法数量的错误信息。
- 快照 schema、日期排序、重复日期和非负整数校验。
- 同日覆盖、跨日补齐、数量下降以及无变化幂等。
- SVG 对下降曲线仍能稳定渲染，描述不再使用 cumulative。
- workflow 同时检查、add `assets/star-history-data.json` 和 `assets/star-history.svg`，且不调用 Stargazers 列表接口。

本地完成脚本定向测试、完整 `npm test -- --run`、`npm run typecheck`、`npm run build`、`npm run release-note:check` 和 `git diff --check`。推送后手动触发 `Update Star History`，验收标准为 metadata 请求成功、生成步骤成功、无变化时绿色退出；若数量变化，则机器人同时提交 JSON 与 SVG。

## 非目标

- 不恢复每个 Stargazer 的身份或精确到秒的 Star 时间。
- 不配置或轮换 PAT。
- 不调整图表样式、README 布局或 workflow 调度频率。
- 不修改 PR #76 的 Release workflow 修复。
