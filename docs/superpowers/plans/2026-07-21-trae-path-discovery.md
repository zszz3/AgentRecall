# Trae 双目录路径发现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让默认 Trae 索引同时扫描官方 `.trae` 与兼容版 `.trae-cn`，并补齐回归测试、文档和发布说明。

**Architecture:** 保留现有单根目录 Trae 解析器；在默认会话迭代器中直接按固定目录名依次调用它。不引入通配发现、去重或新的公开 API。

**Tech Stack:** TypeScript, Vitest, Node.js path/fs, Markdown。

---

### Task 1: Add failing default-discovery tests

**Files:**
- Modify: `src/core/session-loader-extra-sources.test.ts`

- [x] Add temporary-home fixtures for `.trae` alone, `.trae-cn` alone, and both together.
- [x] Assert the default loader returns all expected Trae raw IDs while the existing explicit-root test remains unchanged.
- [x] Run `npx vitest run src/core/session-loader-extra-sources.test.ts -t "Trae"` and observe failure because the default iterator only visits `.trae-cn`.

### Task 2: Implement fixed dual-root discovery

**Files:**
- Modify: `src/core/session-loader.ts`

- [x] Set the no-argument single-root default to `path.join(os.homedir(), ".trae")`.
- [x] Add the internal fixed names `const TRAE_DIR_NAMES = [".trae", ".trae-cn"] as const`.
- [x] In `loadDefaultSessionsIterator`, when `includeTrae` is enabled, call `loadTraeSessionsIterator(path.join(homeDir, dirName), options)` once for each name.
- [x] Re-run the focused tests and confirm both directory fixtures pass.

### Task 3: Synchronize user-facing paths and release note

**Files:**
- Modify: `README.md`
- Modify: `docs/README.en.md`
- Create: `.release-notes/fix-trae-path-discovery.md`

- [x] Document both fixed Trae roots in the concise user-facing path line.
- [x] Add one user-facing bug-fix release note explaining that official Trae sessions are no longer missed.
- [x] Run `npm run release-note:check`.

### Task 4: Verify and hand off

- [ ] Run the focused Trae tests, `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Record unrelated baseline failures without changing them.
- [ ] Inspect the staged file list and ensure `.trae/` and `.understand-anything/` are absent.
- [ ] Request code review, address critical/important feedback, commit, push `fix-trae-path-discovery`, and create the Chinese PR against `main`.
