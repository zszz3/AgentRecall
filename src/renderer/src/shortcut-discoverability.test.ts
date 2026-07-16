import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(new URL("./features/settings/settings-dialog.tsx", import.meta.url), "utf8");

function sourceBlock(startNeedle: string, endNeedle: string): string {
  const start = settingsSource.indexOf(startNeedle);
  const end = settingsSource.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return settingsSource.slice(start, end);
}

describe("shortcut discoverability", () => {
  it("lists every product-level app shortcut with platform-aware modifiers", () => {
    const shortcutSettings = sourceBlock(
      '{activeSection === "shortcut" ? (',
      '{activeSection === "connections" ? (',
    );

    expect(settingsSource).toContain('const appShortcutModifier = platform === "darwin" ? "⌘" : "Ctrl";');
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
      expect(settingsSource).toContain(label);
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
      expect(settingsSource).toContain(keys);
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
    expect(shortcutReference).toContain("<dt>");
    expect(shortcutReference).toContain("{shortcut.label}");
    expect(shortcutReference).toContain("<kbd>{key}</kbd>");
    expect(shortcutReference).not.toMatch(/<(?:input|select|button)\b/);
  });

  it("joins keys in the same shortcut with a visible plus sign", () => {
    const shortcutReference = sourceBlock(
      '<section className="shortcut-reference"',
      "</section>",
    );

    expect(shortcutReference).toContain("{keyGroup.map((key, keyIndex) => (");
    expect(shortcutReference).toContain(
      '{keyIndex > 0 ? <span className="shortcut-reference-combo-separator">+</span> : null}',
    );
  });

  it("maps paired match actions explicitly for assistive technology", () => {
    const shortcutReference = sourceBlock(
      '<section className="shortcut-reference"',
      "</section>",
    );

    expect(settingsSource).toContain(
      'l("Previous match: Shift + Enter; next match: Enter", "上一个匹配：Shift + Enter；下一个匹配：Enter")',
    );
    expect(shortcutReference).toContain('<span className="shortcut-reference-accessible">{shortcut.accessibleLabel}</span>');
    expect(shortcutReference).toContain('<dd aria-hidden={shortcut.accessibleLabel ? "true" : undefined}>');
  });
});
