# SQLite 核心会话、搜索与统计仓储

## 新增功能

- 新增基于内置 `node:sqlite` 与 FTS5 `trigram` 的核心会话、回合、搜索、统计与子会话族谱仓储实现，并通过 PostgreSQL 与 SQLite 双引擎契约测试校验行为一致。
