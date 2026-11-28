# 默认切换单引擎 SQLite 运行时与内置 PostgreSQL 原子迁移

## 新增功能

- 将 AgentRecall 2.0 本地存储默认切换为基于 `node:sqlite`（WAL + FTS5 `trigram`）的单文件 SQLite 引擎，覆盖桌面主进程、独立搜索后台、索引与团队下载 Worker 及独立 MCP 入口。
- 首次从已有内置 PostgreSQL 数据升级时自动执行只读快照 + 47 张表逐表行数与外键/FTS5 校验的原子迁移，完整保留原有 `postgres/data` 目录，并支持通过 `AGENT_RECALL_DB_ENGINE=postgres` 随时回退。
