import { Fragment } from "react";
import type { ReactElement } from "react";

import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import { globalShortcutOptions } from "../../../../core/shortcuts";
import { localize, type LanguageMode } from "../../language";

export function ShortcutSettings({
  language,
  platform,
  settings,
  saving,
  onSettingsChange,
}: {
  language: LanguageMode;
  platform: NodeJS.Platform;
  settings: AppSettings | null;
  saving: boolean;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const globalShortcut = settings?.globalShortcut ?? (platform === "win32" ? "Ctrl+Alt+Space" : "Alt+Space");
  const appShortcutModifier = platform === "darwin" ? "⌘" : "Ctrl";
  const appShortcuts: Array<{ label: string; keyGroups: string[][]; accessibleLabel?: string }> = [
    { label: l("Focus search", "聚焦搜索"), keyGroups: [[appShortcutModifier, "F"]] },
    { label: l("Search", "执行搜索"), keyGroups: [["Enter"]] },
    { label: l("Select session", "选择会话"), keyGroups: [["↑"], ["↓"]] },
    { label: l("Open details", "打开详情"), keyGroups: [["Space"]] },
    { label: l("Resume selected session", "恢复选中会话"), keyGroups: [[appShortcutModifier, "Enter"]] },
    { label: l("Find in conversation", "会话内查找"), keyGroups: [[appShortcutModifier, "F"]] },
    {
      label: l("Previous / next match", "上一个 / 下一个匹配"),
      keyGroups: [["Shift", "Enter"], ["Enter"]],
      accessibleLabel: l("Previous match: Shift + Enter; next match: Enter", "上一个匹配：Shift + Enter；下一个匹配：Enter"),
    },
    { label: l("Close current panel or dialog", "关闭当前面板或弹窗"), keyGroups: [["Esc"]] },
  ];

  return (
    <section className="settings-pane">
      <header className="settings-pane-head">
        <h3>{l("Global shortcut", "全局快捷键")}</h3>
        <p>{l("Choose the system-wide shortcut used to open or hide the search window.", "选择用于打开或隐藏搜索窗口的系统级快捷键。")}</p>
      </header>
      <div className="settings-field">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Open search window", "打开搜索窗口")}</span>
          <span className="settings-field-sub">{l("If another app owns the shortcut, this setting will fail to save.", "如果快捷键被其他应用占用，保存会失败。")}</span>
        </div>
        <select
          id="global-shortcut"
          value={globalShortcut}
          disabled={!settings || saving}
          onChange={(event) => onSettingsChange({ globalShortcut: event.target.value as AppSettings["globalShortcut"] })}
        >
          {globalShortcutOptions(platform).map((option) => (
            <option key={option.label} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <section className="shortcut-reference" aria-labelledby="app-shortcuts-title">
        <header className="shortcut-reference-head">
          <h4 id="app-shortcuts-title">{l("App shortcuts", "应用内快捷键")}</h4>
          <p>{l("These shortcuts cannot be customized.", "这些快捷键不可自定义。")}</p>
        </header>
        <dl className="shortcut-reference-list">
          {appShortcuts.map((shortcut) => (
            <div className="shortcut-reference-row" key={shortcut.label}>
              <dt>
                {shortcut.label}
                {shortcut.accessibleLabel ? <span className="shortcut-reference-accessible">{shortcut.accessibleLabel}</span> : null}
              </dt>
              <dd aria-hidden={shortcut.accessibleLabel ? "true" : undefined}>
                {shortcut.keyGroups.map((keyGroup, groupIndex) => (
                  <span className="shortcut-reference-group" key={keyGroup.join("+")}>
                    <span className="shortcut-reference-combo">
                      {keyGroup.map((key, keyIndex) => (
                        <Fragment key={key}>
                          {keyIndex > 0 ? <span className="shortcut-reference-combo-separator">+</span> : null}
                          <kbd>{key}</kbd>
                        </Fragment>
                      ))}
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
    </section>
  );
}
