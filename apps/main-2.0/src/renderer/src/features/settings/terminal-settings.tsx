import type { ReactElement } from "react";

import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import { terminalSelectOptions } from "../../../../core/terminal-options";
import { localize, type LanguageMode } from "../../language";

export function TerminalSettings({
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
  const defaultTerminal = settings?.defaultTerminal ?? (platform === "win32" ? "WindowsTerminal" : "Terminal");

  return (
    <section className="settings-pane">
      <header className="settings-pane-head">
        <h3>{l("Default terminal", "默认终端")}</h3>
        <p>{l("Choose which terminal app Resume and the selected-session shortcut use to reopen a session.", "选择 Resume 和选中会话快捷键用于恢复会话的终端应用。")}</p>
      </header>
      <div className="settings-field">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Terminal app", "终端应用")}</span>
          <span className="settings-field-sub">{l("Applies to Resume and the selected-session shortcut.", "应用于 Resume 和选中会话快捷键。")}</span>
        </div>
        <select
          id="default-terminal"
          value={defaultTerminal}
          disabled={!settings || saving}
          onChange={(event) => onSettingsChange({ defaultTerminal: event.target.value as AppSettings["defaultTerminal"] })}
        >
          {terminalSelectOptions(platform).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
