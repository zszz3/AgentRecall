# ADR 0033：统一使用单引擎本地 SQLite 存储并移除内置 PostgreSQL

## 状态

已采用。

## 背景

AgentRecall 2.0 早期在单机桌面端内嵌了 `embedded-postgres` + `@embedded-postgres/*` 与 `pg` 驱动，测试侧额外引入 `@electric-sql/pglite`，带来四类持续负担：

1. **安装体积与分发复杂度**：每个平台的内置 PostgreSQL 运行时约 140–200 MB，且需在 `postinstall`、热更新暂存、macOS 打包与启动前校验中维护原生动态库符号链接修复与自包含检查；
2. **后台进程与启动延迟**：每次冷启动需等待独立 `postgres` 守护进程拉起与端口探测，在 Windows 管理员终端下还会被 PostgreSQL 进程拒绝启动，且异常退出易残留 `postmaster.pid`；
3. **测试与开发反馈慢**：每次单元测试通过 PGlite WASM 初始化 65 个 PostgreSQL 迁移，单次套件耗时长；
4. **双引擎维护成本**：Phase 1–3 通过双引擎契约测试和自动迁移桥接完成了从内置 PostgreSQL 到 SQLite 的平稳过渡，继续长期维护两套 DDL 与仓储只会重复劳动。

## 决策

1. **单引擎本地 SQLite（`node:sqlite` + WAL + FTS5 `trigram`）**：
   - 统一使用 Node.js / Electron 42 内置的 `node:sqlite`（`DatabaseSync`），零原生编译、零额外 C++ addon；
   - 默认数据文件为 `<userData>/agent-recall.sqlite`（发现指针 `~/.agent-recall-v2/database-url` 记录 `sqlite:<path>`），开启 `journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=10000`、`temp_store=MEMORY`；
   - 写事务通过 `BEGIN IMMEDIATE` + 单线程异步串行队列（含可重入 `SAVEPOINT`）与跨进程 WAL 并发保障读写不互阻；
   - 全文检索（含中日韩子串与长会话正文）使用内置 FTS5 `trigram` 虚拟表（`sessions_fts`、`session_turns_fts`、`memory_cards_fts`），短于 3 个 Unicode 码点的查询自动退回参数化 `LIKE` 匹配（`ESCAPE '\'`），同时保留与既有搜索契约一致的排序与片段高亮。
2. **移除所有内置 PostgreSQL 运行时、代码与依赖**：
   - 从 `apps/main-2.0/package.json` 及锁文件中移除 `embedded-postgres`、`@embedded-postgres/*`、`pg`、`@types/pg` 与 `@electric-sql/pglite`；
   - 移除 `src/core/postgres/`、`src/main/postgres/`、`bin/embedded-postgres-runtime.cjs`、旧 PG 仓储与 Phase 3 一次性 PG→SQLite 迁移桥接代码，以及更新器/打包脚本中的 PostgreSQL 链接修复与进程校验逻辑；
   - 浏览器安全领域类型统一收敛至 `src/core/storage/types.ts`，保持 `src/renderer` 零 `node:*` 依赖的架构边界。
3. **跨进程共享契约不变**：
   - 桌面主进程、常驻搜索后台（`session-backend`）、本地索引 worker、团队下载 worker、CLI 与独立 MCP 入口（`agent-recall-mcp`、`agent-recall-eval-mcp`、`gateway-entry`）继续遵循既有进程边界，共享同一本地 SQLite 文件。

## 影响

- `apps/main-2.0/node_modules` 体积显著缩减（移除 19 个 PG 相关包，减少约 200 MB），不再包含独立数据库守护进程与平台原生二进制；
- 冷启动与集成测试显著提速，Windows 管理员终端不再因数据库权限检查被阻断；
- 需要从旧版 PostgreSQL 自动迁移历史数据的用户通过 Phase 3 过渡版本完成一次性迁移；历史 `<userData>/postgres/` 目录不会被新版本主动删除，仍保留在磁盘上供人工回溯；
- 后续扩展向量/语义检索时，可在同一 SQLite 数据库上直接集成 `sqlite-vec` 或增量加载扩展，无需重新引入独立数据库服务。

## 考虑的替代方案

- **继续保留内置 PostgreSQL + pgvector**：单机场景进程与分发包过重，与桌面工具轻量目标背道而驰，放弃；
- **使用 `better-sqlite3`**：需为 Electron ABI 与多平台分别编译原生 `.node` 产物，维护成本高于 Node/Electron 原生内置的 `node:sqlite`，放弃；
- **长期维护 PostgreSQL + SQLite 双引擎**：所有 schema 变更、查询与测试都需要写两份且持续做双引擎对齐，维护成本高，在 Phase 3 验证稳定后决定彻底收敛为单引擎 SQLite。

## 关联

- [会话索引规格](../spec/session-indexing.md)
- [团队资产规格](../spec/team-assets.md)
- [Memory 规格](../spec/memory.md)
- [SQLite 数据库封装](../../apps/main-2.0/src/core/sqlite/database.ts)
- [SQLite Schema 与 FTS5 定义](../../apps/main-2.0/src/core/sqlite/schema.ts)
- [存储仓储契约](../../apps/main-2.0/src/core/storage/repositories.ts)
- [SQLite 契约测试](../../apps/main-2.0/src/core/sqlite/session-contract.test.ts)
