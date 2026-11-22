import type { ReactElement } from "react";
import { Languages, Monitor, Moon, Sun, Type } from "lucide-react";

import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import { localize, type LanguageMode } from "../../language";
import {
  MESSAGE_FONT_SIZE_SCALES,
  type MessageFontSizeScale,
} from "../../message-font-size";
import type { ThemeMode } from "../../theme";

export function AppearanceSettings({
  language,
  platform,
  settings,
  theme,
  messageFontSize,
  onThemeChange,
  onLanguageChange,
  onMessageFontSizeChange,
  onSettingsChange,
}: {
  language: LanguageMode;
  platform: NodeJS.Platform;
  settings: AppSettings | null;
  theme: ThemeMode;
  messageFontSize: MessageFontSizeScale;
  onThemeChange: (theme: ThemeMode) => void;
  onLanguageChange: (language: LanguageMode) => void;
  onMessageFontSizeChange: (scale: MessageFontSizeScale) => void;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);

  return (
    <section className="settings-pane">
      <header className="settings-pane-head">
        <h3>{l("Appearance", "外观")}</h3>
        <p>{l("Choose the color theme, language, and interface text size.", "选择颜色主题、语言和界面字号。")}</p>
      </header>
      <div className="settings-field">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Theme", "主题")}</span>
          <span className="settings-field-sub">{l("Saved on this device.", "保存在当前设备。")}</span>
        </div>
        <div className="theme-setting-toggle" role="group" aria-label={l("Theme", "主题")}>
          <button className={theme === "system" ? "active" : ""} onClick={() => onThemeChange("system")}>
            <Monitor size={14} />
            <span>{l("System", "跟随系统")}</span>
          </button>
          <button className={theme === "light" ? "active" : ""} onClick={() => onThemeChange("light")}>
            <Sun size={14} />
            <span>{l("Light", "浅色")}</span>
          </button>
          <button className={theme === "dark" ? "active" : ""} onClick={() => onThemeChange("dark")}>
            <Moon size={14} />
            <span>{l("Dark", "深色")}</span>
          </button>
        </div>
      </div>
      <div className="settings-field">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Language", "语言")}</span>
          <span className="settings-field-sub">{l("Controls app chrome and settings text.", "控制应用界面和设置文案。")}</span>
        </div>
        <div className="language-setting-toggle" role="group" aria-label={l("Language", "语言")}>
          <button className={language === "en" ? "active" : ""} onClick={() => onLanguageChange("en")}>
            <Languages size={14} />
            <span>English</span>
          </button>
          <button className={language === "zh" ? "active" : ""} onClick={() => onLanguageChange("zh")}>
            <Languages size={14} />
            <span>中文</span>
          </button>
        </div>
      </div>
      <div className="settings-field">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Interface text size", "界面字号")}</span>
          <span className="settings-field-sub">
            {l("Scales the whole app interface, including session messages.", "缩放整个应用界面，包括会话正文。")}
          </span>
        </div>
        <div className="message-font-size-setting-toggle" role="group" aria-label={l("Interface text size", "界面字号")}>
          {MESSAGE_FONT_SIZE_SCALES.map((scale) => (
            <button
              key={scale}
              className={messageFontSize === scale ? "active" : ""}
              onClick={() => onMessageFontSizeChange(scale)}
            >
              <Type size={14} />
              <span>
                {scale === "medium"
                  ? l("Medium", "标准")
                  : scale === "medium-large"
                    ? l("Medium large", "稍大")
                    : scale === "large"
                      ? l("Large", "大")
                      : l("Extra large", "更大")}
              </span>
            </button>
          ))}
        </div>
      </div>
      {platform === "darwin" ? (
        <label className="settings-field settings-toggle">
          <div className="settings-field-text">
            <span className="settings-field-title">{l("Keep in Dock", "保留在程序坞")}</span>
            <span className="settings-field-sub">
              {l(
                "Turn this off to use AgentRecall only from the menu bar. Enabled by default.",
                "关闭后仅从顶部菜单栏使用 AgentRecall，默认开启。",
              )}
            </span>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={settings?.showInDock !== false}
            disabled={!settings}
            onChange={(event) => onSettingsChange({ showInDock: event.currentTarget.checked })}
          />
        </label>
      ) : null}
    </section>
  );
}
