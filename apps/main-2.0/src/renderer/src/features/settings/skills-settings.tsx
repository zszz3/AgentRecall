import type { ReactElement } from "react";

import { agentModelLabel } from "../../../../core/agent-model-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import { localize, type LanguageMode } from "../../language";
import { SupabaseSetupGuide } from "../../components/supabase-setup-guide";
import { SettingsTextInput } from "./settings-text-input";

export function SkillsSettings({
  language,
  settings,
  hasPendingSetting,
  onSettingsChange,
  onOpenAgentModel,
}: {
  language: LanguageMode;
  settings: AppSettings | null;
  hasPendingSetting: (...keys: Array<keyof AppSettingsUpdate>) => boolean;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onOpenAgentModel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const skillModel = agentModelLabel(settings?.agentModel);

  return (
    <section className="settings-pane">
      <header className="settings-pane-head settings-pane-head-row">
        <div>
          <h3>{l("AI Skill exploration", "AI Skill 探索")}</h3>
          <p>{l(
            `The AgentRecall model understands natural-language requests before searching skills.sh. Model in use: ${skillModel ?? "not set up"}.`,
            `由 AgentRecall 模型理解自然语言需求，再搜索 skills.sh。当前模型：${skillModel ?? "尚未设置"}。`,
          )}</p>
        </div>
        <button type="button" className="settings-action-button" onClick={onOpenAgentModel}>
          {l("Configure model", "设置模型")}
        </button>
      </header>
      <header className="settings-pane-head" style={{ marginTop: 18 }}>
        <h3>{l("Supabase skill sync", "Supabase Skill 同步")}</h3>
        <p>
          {l(
            "Use your own Supabase project to upload local skills and install them on another machine. Get the Project URL and anon key from supabase.com/dashboard.",
            "使用你自己的 Supabase 项目上传本地 Skills，并在另一台机器安装。可在 supabase.com/dashboard 获取 Project URL 和 anon key。",
          )}
        </p>
      </header>
      <label className="settings-field skills-sync-field">
        <div className="settings-field-text">
          <span className="settings-field-title">Supabase URL</span>
          <span className="settings-field-sub">https://your-project.supabase.co</span>
        </div>
        <SettingsTextInput
          type="text"
          value={settings?.skillSyncSupabaseUrl ?? ""}
          disabled={!settings || hasPendingSetting("skillSyncSupabaseUrl")}
          placeholder="https://your-project.supabase.co"
          onCommit={(value) => onSettingsChange({ skillSyncSupabaseUrl: value })}
        />
      </label>
      <label className="settings-field skills-sync-field">
        <div className="settings-field-text">
          <span className="settings-field-title">anon key</span>
          <span className="settings-field-sub">{l("Stored locally and used only for the skills sync table.", "保存在本地，仅用于 Skills 同步表。")}</span>
        </div>
        <SettingsTextInput
          type="password"
          value={settings?.skillSyncSupabaseAnonKey ?? ""}
          disabled={!settings || hasPendingSetting("skillSyncSupabaseAnonKey")}
          placeholder="eyJhbGciOi..."
          onCommit={(value) => onSettingsChange({ skillSyncSupabaseAnonKey: value })}
        />
      </label>
      <SupabaseSetupGuide
        language={language}
        tone="info"
        title={l("First-time setup", "首次配置")}
        message={l(
          "The same setup SQL initializes session and Skill sync. Run it once in this project's SQL Editor, then enable sync.",
          "同一份初始化 SQL 会同时准备会话和 Skill 同步，请在当前项目的 SQL Editor 中执行一次，然后启用同步。",
        )}
        onCopySql={() => window.sessionSearch.copyCombinedSyncSetupSql()}
        onOpenSqlEditor={() => window.sessionSearch.openSupabaseSqlEditor("skills")}
      />
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Enable Supabase sync", "启用 Supabase 同步")}</span>
          <span className="settings-field-sub">
            {l("Advanced automatic table creation is not used; the app will show SQL when the table is missing.", "不使用高级自动建表；缺表时应用会展示可复制的初始化 SQL。")}
          </span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.skillSyncEnabled)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ skillSyncEnabled: event.currentTarget.checked })}
        />
      </label>
    </section>
  );
}
