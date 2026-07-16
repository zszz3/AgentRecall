# App Shortcut Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页的全局快捷键区域增加只读的应用内快捷键清单，让用户能一次看到搜索、会话选择、详情查看和会话恢复等常用键位。

**Architecture:** 继续由现有 `SettingsDialog` 渲染快捷键设置，不新增状态、持久化字段或可复用导出。组件内根据 `RUNTIME_PLATFORM` 生成 `⌘` 或 `Ctrl` 标签，使用语义化 `<dl>` 和 `<kbd>` 输出八项只读说明；现有 renderer 源码契约测试验证结构和文案，样式契约测试验证桌面与窄窗口布局。

**Tech Stack:** Electron、React、TypeScript、CSS、Vitest

## Global Constraints

- 只展示产品级快捷键，不展示 `PageUp`、`PageDown`、`Home`、`End` 等通用滚动键。
- 不增加快捷键自定义、录制、持久化或新的帮助弹窗。
- 全局唤起快捷键继续由现有选择器展示，不在只读清单中重复。
- macOS 使用 `⌘`，Windows / Linux 使用 `Ctrl`；其余按键文案保持一致。
- 中英文文案必须成对出现，中文保持直接、简短。
- 不新增依赖，不导出只为测试服务的实现细节。
- 分支新增且只新增一个 `.release-notes/*.md` 文件，内容只描述用户可见结果。
- 完整验证使用 Node 22 和临时 `HOME=/private/tmp/agent-recall-shortcut-home`，不得读写真实用户会话或配置。

---

### Task 1: 在设置页渲染只读快捷键清单

**Files:**
- Create: `src/renderer/src/shortcut-discoverability.test.ts`
- Modify: `src/renderer/src/App.tsx:3174`
- Modify: `src/renderer/src/App.tsx:3283`

**Interfaces:**
- Consumes: `RUNTIME_PLATFORM: NodeJS.Platform`、`localize(language, en, zh): string`、现有 `SettingsDialog` 快捷键设置区。
- Produces: `appShortcutModifier: string`、组件内 `appShortcuts: Array<{ label: string; keyGroups: string[][] }>`、`.shortcut-reference` 只读语义结构。

- [ ] **Step 1: 写失败的 renderer 契约测试**

创建 `src/renderer/src/shortcut-discoverability.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

function sourceBlock(startNeedle: string, endNeedle: string): string {
  const start = appSource.indexOf(startNeedle);
  const end = appSource.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return appSource.slice(start, end);
}

describe("shortcut discoverability", () => {
  it("lists every product-level app shortcut with platform-aware modifiers", () => {
    const shortcutSettings = sourceBlock(
      '{activeSection === "shortcut" ? (',
      '{activeSection === "connections" ? (',
    );

    expect(appSource).toContain('const appShortcutModifier = RUNTIME_PLATFORM === "darwin" ? "⌘" : "Ctrl";');
    for (const label of [
      'l("Focus search", "聚焦搜索")',
      'l("Search", "执行搜索")',
      'l("Select session", "选择会话")',
      'l("Open details", "打开详情")',
      'l("Resume selected session", "恢复选中会话")',
      'l("Find in conversation", "会话内查找")',
      'l("Previous / next match", "上一个 / 下一个匹配")',
      'l("Close current panel or dialog", "关闭当前面板或弹窗")',
    ]) {
      expect(appSource).toContain(label);
    }
    for (const keys of [
      'keyGroups: [[appShortcutModifier, "K"]]',
      'keyGroups: [["Enter"]]',
      'keyGroups: [["↑"], ["↓"]]',
      'keyGroups: [["Space"]]',
      'keyGroups: [[appShortcutModifier, "Enter"]]',
      'keyGroups: [[appShortcutModifier, "F"]]',
      'keyGroups: [["Shift", "Enter"], ["Enter"]]',
      'keyGroups: [["Esc"]]',
    ]) {
      expect(appSource).toContain(keys);
    }
    expect(shortcutSettings).toContain('l("App shortcuts", "应用内快捷键")');
    expect(shortcutSettings).toContain('l("These shortcuts cannot be customized.", "这些快捷键不可自定义。")');
  });

  it("renders the shortcut reference as semantic read-only content", () => {
    const shortcutReference = sourceBlock(
      '<section className="shortcut-reference"',
      "</section>",
    );

    expect(shortcutReference).toContain('<dl className="shortcut-reference-list">');
    expect(shortcutReference).toContain("<dt>{shortcut.label}</dt>");
    expect(shortcutReference).toContain("<kbd key={key}>{key}</kbd>");
    expect(shortcutReference).not.toMatch(/<(?:input|select|button)\b/);
  });
});
```

- [ ] **Step 2: 运行测试，确认它因功能缺失而失败**

Run: `npx vitest run src/renderer/src/shortcut-discoverability.test.ts`

Expected: FAIL；`sourceBlock` 找不到 `.shortcut-reference`，或源码中缺少 `appShortcutModifier`。

- [ ] **Step 3: 在 `SettingsDialog` 中定义平台标签和八项快捷键**

在 `src/renderer/src/App.tsx` 的 `const l = ...` 后加入：

```ts
  const appShortcutModifier = RUNTIME_PLATFORM === "darwin" ? "⌘" : "Ctrl";
  const appShortcuts: Array<{ label: string; keyGroups: string[][] }> = [
    { label: l("Focus search", "聚焦搜索"), keyGroups: [[appShortcutModifier, "K"]] },
    { label: l("Search", "执行搜索"), keyGroups: [["Enter"]] },
    { label: l("Select session", "选择会话"), keyGroups: [["↑"], ["↓"]] },
    { label: l("Open details", "打开详情"), keyGroups: [["Space"]] },
    { label: l("Resume selected session", "恢复选中会话"), keyGroups: [[appShortcutModifier, "Enter"]] },
    { label: l("Find in conversation", "会话内查找"), keyGroups: [[appShortcutModifier, "F"]] },
    { label: l("Previous / next match", "上一个 / 下一个匹配"), keyGroups: [["Shift", "Enter"], ["Enter"]] },
    { label: l("Close current panel or dialog", "关闭当前面板或弹窗"), keyGroups: [["Esc"]] },
  ];
```

- [ ] **Step 4: 在全局快捷键选择器下渲染只读清单**

在 `activeSection === "shortcut"` 的现有 `.settings-field` 后加入：

```tsx
                <section className="shortcut-reference" aria-labelledby="app-shortcuts-title">
                  <header className="shortcut-reference-head">
                    <h4 id="app-shortcuts-title">{l("App shortcuts", "应用内快捷键")}</h4>
                    <p>{l("These shortcuts cannot be customized.", "这些快捷键不可自定义。")}</p>
                  </header>
                  <dl className="shortcut-reference-list">
                    {appShortcuts.map((shortcut) => (
                      <div className="shortcut-reference-row" key={shortcut.label}>
                        <dt>{shortcut.label}</dt>
                        <dd>
                          {shortcut.keyGroups.map((keyGroup, groupIndex) => (
                            <span className="shortcut-reference-group" key={keyGroup.join("+")}>
                              <span className="shortcut-reference-combo">
                                {keyGroup.map((key) => <kbd key={key}>{key}</kbd>)}
                              </span>
                              {groupIndex < shortcut.keyGroups.length - 1 ? (
                                <span className="shortcut-reference-separator" aria-hidden="true">/</span>
                              ) : null}
                            </span>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
```

- [ ] **Step 5: 运行测试，确认结构和文案通过**

Run: `npx vitest run src/renderer/src/shortcut-discoverability.test.ts`

Expected: PASS，2 tests passed。

- [ ] **Step 6: 提交语义结构**

```bash
git add src/renderer/src/App.tsx src/renderer/src/shortcut-discoverability.test.ts
git commit -m "feat: show app shortcut reference"
```

---

### Task 2: 添加键帽样式和窄窗口布局

**Files:**
- Modify: `src/renderer/src/style-contract.test.ts`
- Modify: `src/renderer/src/styles.css:4599`
- Modify: `src/renderer/src/styles.css:5447`

**Interfaces:**
- Consumes: Task 1 产生的 `.shortcut-reference`、`.shortcut-reference-row`、`.shortcut-reference-group`、`.shortcut-reference-combo` 和 `<kbd>` 结构。
- Produces: 桌面双列布局、可换行的按键组合、640px 以下单列布局。

- [ ] **Step 1: 写失败的样式契约测试**

在 `src/renderer/src/style-contract.test.ts` 的 `describe` 中加入：

```ts
  it("keeps the app shortcut reference readable in narrow settings panes", () => {
    const reference = stylesheet.match(/\.shortcut-reference\s*\{[^}]*\}/)?.[0] ?? "";
    const row = stylesheet.match(/\.shortcut-reference-row\s*\{[^}]*\}/)?.[0] ?? "";
    const keys = stylesheet.match(/\.shortcut-reference-row dd\s*\{[^}]*\}/)?.[0] ?? "";
    const keycap = stylesheet.match(/\.shortcut-reference-combo kbd\s*\{[^}]*\}/)?.[0] ?? "";
    const narrowRow = stylesheet.match(/@media \(max-width:\s*640px\)\s*\{[\s\S]*?\.shortcut-reference-row\s*\{[^}]*\}/)?.[0] ?? "";

    expect(reference).toMatch(/display:\s*grid/);
    expect(row).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
    expect(keys).toMatch(/flex-wrap:\s*wrap/);
    expect(keys).toMatch(/justify-content:\s*flex-end/);
    expect(keycap).toMatch(/font-family:\s*var\(--mono\)/);
    expect(keycap).toMatch(/white-space:\s*nowrap/);
    expect(narrowRow).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
```

- [ ] **Step 2: 运行样式测试，确认它因样式缺失而失败**

Run: `npx vitest run src/renderer/src/style-contract.test.ts`

Expected: FAIL；`.shortcut-reference` 匹配结果为空，缺少 `display: grid`。

- [ ] **Step 3: 在设置页样式附近加入快捷键清单样式**

在 `src/renderer/src/styles.css` 的 `.settings-field` 相关规则后加入：

```css
.shortcut-reference {
  display: grid;
  gap: 12px;
  padding: 15px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: var(--panel-subtle);
}

.shortcut-reference-head {
  display: grid;
  gap: 3px;
}

.shortcut-reference-head h4,
.shortcut-reference-head p,
.shortcut-reference-list {
  margin: 0;
}

.shortcut-reference-head h4 {
  color: var(--text);
  font-size: 13.5px;
}

.shortcut-reference-head p {
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.4;
}

.shortcut-reference-list {
  display: grid;
}

.shortcut-reference-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 9px 0;
  border-top: 1px solid var(--border-subtle);
}

.shortcut-reference-row dt {
  color: var(--text);
  font-size: 13px;
}

.shortcut-reference-row dd {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  margin: 0;
}

.shortcut-reference-group,
.shortcut-reference-combo {
  display: inline-flex;
  align-items: center;
}

.shortcut-reference-group {
  gap: 6px;
}

.shortcut-reference-combo {
  gap: 4px;
}

.shortcut-reference-combo kbd {
  min-width: 28px;
  padding: 4px 7px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--panel-bg);
  color: var(--text);
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1;
  text-align: center;
  white-space: nowrap;
}

.shortcut-reference-separator {
  color: var(--text-muted);
  font-size: 11px;
}
```

- [ ] **Step 4: 在现有 640px media query 中加入单列规则**

```css
  .shortcut-reference-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 7px;
  }

  .shortcut-reference-row dd {
    justify-content: flex-start;
  }
```

- [ ] **Step 5: 运行 renderer 测试，确认结构和样式同时通过**

Run: `npx vitest run src/renderer/src/shortcut-discoverability.test.ts src/renderer/src/style-contract.test.ts`

Expected: PASS，两个测试文件全部通过。

- [ ] **Step 6: 提交样式**

```bash
git add src/renderer/src/styles.css src/renderer/src/style-contract.test.ts
git commit -m "style: format app shortcut reference"
```

---

### Task 3: 添加发布说明并完成全量验证

**Files:**
- Create: `.release-notes/feat-shortcut-discoverability.md`

**Interfaces:**
- Consumes: Task 1 和 Task 2 完成的用户可见快捷键清单。
- Produces: 一个符合仓库发布门禁的新增功能说明，以及可提交的已验证分支状态。

- [ ] **Step 1: 添加用户向发布说明**

创建 `.release-notes/feat-shortcut-discoverability.md`：

```md
# 快捷键更容易找到

## 新增功能

- 设置页新增应用内快捷键清单，可以直接查看搜索、选择会话、打开详情和恢复会话等常用操作的键位。
```

- [ ] **Step 2: 检查发布说明门禁**

Run: `env HOME=/private/tmp/agent-recall-shortcut-home npm run release-note:check`

Expected: `.release-notes/feat-shortcut-discoverability.md: 1 feature(s), 0 fix(es)`。

- [ ] **Step 3: 运行完整测试**

Run: `/bin/zsh -lc 'source /Users/xjx/.nvm/nvm.sh && nvm use 22 >/dev/null && env HOME=/private/tmp/agent-recall-shortcut-home npm test'`

Expected: exit 0；Vitest 现有 982 项加 3 项新测试，共 985 项通过；脚本测试 56 项通过。若沙箱阻止 `127.0.0.1` 监听，在主机环境运行同一命令。

- [ ] **Step 4: 运行类型检查和生产构建**

Run: `env HOME=/private/tmp/agent-recall-shortcut-home npm run typecheck`

Expected: exit 0，无 TypeScript 错误。

Run: `env HOME=/private/tmp/agent-recall-shortcut-home npm run build`

Expected: exit 0，主进程、preload、renderer 和 MCP bundle 均完成构建。

- [ ] **Step 5: 检查最终差异和工作树**

Run: `git diff --check`

Expected: exit 0，无空白错误。

Run: `git status --short --branch`

Expected: 只包含 `.release-notes/feat-shortcut-discoverability.md`；Task 1 和 Task 2 已提交。

- [ ] **Step 6: 提交发布说明**

```bash
git add .release-notes/feat-shortcut-discoverability.md
git commit -m "docs: add shortcut reference release note"
```

- [ ] **Step 7: 确认最终提交状态**

Run: `git status --short --branch`

Expected: 工作树干净，`feat/shortcut-discoverability` 领先 `origin/main` 五个提交：设计规格、实现计划、快捷键清单、样式和发布说明。
