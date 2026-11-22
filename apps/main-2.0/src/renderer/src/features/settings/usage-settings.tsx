import type { ReactElement } from "react";

import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import { localize, type LanguageMode } from "../../language";

export function UsageSettings({
  language,
  settings,
  onSettingsChange,
}: {
  language: LanguageMode;
  settings: AppSettings | null;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);

  return (
    <section className="settings-pane">
      <header className="settings-pane-head">
        <h3>{l("Usage limits", "剩余额度")}</h3>
        <p>{l("Hide a provider in the Remaining panel if you do not have that subscription.", "如果没有某个订阅,可在剩余额度面板中隐藏对应来源。")}</p>
      </header>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Hide Codex usage", "隐藏 Codex 额度")}</span>
          <span className="settings-field-sub">{l("Skip loading and hide the Codex card.", "不加载并隐藏 Codex 额度卡片。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.hideCodexQuota)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ hideCodexQuota: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Hide Claude Code usage", "隐藏 Claude Code 额度")}</span>
          <span className="settings-field-sub">{l("Skip loading and hide the Claude Code card.", "不加载并隐藏 Claude Code 额度卡片。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.hideClaudeQuota)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ hideClaudeQuota: event.currentTarget.checked })}
        />
      </label>
    </section>
  );
}
