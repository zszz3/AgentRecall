import type { ReactElement } from "react";

import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import { localize, type LanguageMode } from "../../language";

export function SourcesSettings({
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
        <h3>{l("Optional sources", "可选来源")}</h3>
        <p>{l("Choose which local agent data sources are monitored and indexed.", "选择要监测和索引的本地 agent 数据源。")}</p>
      </header>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">StepCode</span>
          <span className="settings-field-sub">
            {l(
              "Adds StepCode variants for Claude Code and Codex sessions, resumed through StepCode.",
              "为 Claude Code 和 Codex 会话添加 StepCode 来源，并通过 StepCode 恢复。",
            )}
          </span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeStepcode)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeStepcode: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include Kimi Code</span>
          <span className="settings-field-sub">{l("Indexes local Kimi Code sessions read-only.", "以只读方式索引本地 Kimi Code 会话。")}</span>
        </div>
        <input type="checkbox" className="switch" checked={Boolean(settings?.includeKimiCli)} disabled={!settings} onChange={(event) => onSettingsChange({ includeKimiCli: event.currentTarget.checked })} />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text"><span className="settings-field-title">Include Qwen Code</span><span className="settings-field-sub">{l("Indexes local Qwen Code sessions read-only.", "以只读方式索引本地千问 Code 会话。")}</span></div>
        <input type="checkbox" className="switch" checked={Boolean(settings?.includeQwenCode)} disabled={!settings} onChange={(event) => onSettingsChange({ includeQwenCode: event.currentTarget.checked })} />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text"><span className="settings-field-title">Include Gemini CLI</span><span className="settings-field-sub">{l("Indexes local Gemini CLI sessions read-only.", "以只读方式索引本地 Gemini CLI 会话。")}</span></div>
        <input type="checkbox" className="switch" checked={Boolean(settings?.includeGeminiCli)} disabled={!settings} onChange={(event) => onSettingsChange({ includeGeminiCli: event.currentTarget.checked })} />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text"><span className="settings-field-title">Include Antigravity</span><span className="settings-field-sub">{l("Indexes local Antigravity sessions read-only.", "以只读方式索引本地 Antigravity 会话。")}</span></div>
        <input type="checkbox" className="switch" checked={Boolean(settings?.includeAntigravity)} disabled={!settings} onChange={(event) => onSettingsChange({ includeAntigravity: event.currentTarget.checked })} />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text"><span className="settings-field-title">Include Antigravity CLI</span><span className="settings-field-sub">{l("Indexes local Antigravity CLI sessions read-only and supports terminal Resume.", "以只读方式索引本地 Antigravity CLI 会话，并支持在终端中 Resume 恢复。")}</span></div>
        <input type="checkbox" className="switch" checked={Boolean(settings?.includeAntigravityCli)} disabled={!settings} onChange={(event) => onSettingsChange({ includeAntigravityCli: event.currentTarget.checked })} />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text"><span className="settings-field-title">Include Oh My Pi</span><span className="settings-field-sub">{l("Indexes local omp sessions from ~/.omp/agent/sessions read-only, including subagent transcripts.", "以只读方式索引 ~/.omp/agent/sessions 中的本地 omp 会话，包括子代理转录。")}</span></div>
        <input type="checkbox" className="switch" checked={Boolean(settings?.includeOmp)} disabled={!settings} onChange={(event) => onSettingsChange({ includeOmp: event.currentTarget.checked })} />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include CodeWiz</span>
          <span className="settings-field-sub">{l("Indexes CodeWiz sessions from ~/.local/share/codewiz.", "索引 ~/.local/share/codewiz 中的 CodeWiz 会话。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeCodeWizCli)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeCodeWizCli: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include ~/.tclaude</span>
          <span className="settings-field-sub">{l("Indexes TClaude CLI sessions and allows migration to that CLI.", "索引 TClaude CLI 会话，并允许迁移到该 CLI。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeTclaude)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeTclaude: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include ~/.tcodex</span>
          <span className="settings-field-sub">{l("Indexes TCodex CLI sessions and allows migration to that CLI.", "索引 TCodex CLI 会话，并允许迁移到该 CLI。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeTcodex)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeTcodex: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include ~/.codebuddy</span>
          <span className="settings-field-sub">{l("Adds a separate CodeBuddy CLI source filter.", "添加独立的 CodeBuddy CLI 来源过滤项。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeCodeBuddyCli)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeCodeBuddyCli: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include WorkBuddy</span>
          <span className="settings-field-sub">
            {l("Indexes sessions under ~/.workbuddy/projects in read-only mode.", "以只读方式索引 ~/.workbuddy/projects 中的会话。")}
          </span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeWorkBuddy)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeWorkBuddy: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include OpenClaw</span>
          <span className="settings-field-sub">{l("Indexes local OpenClaw session files.", "索引本地 OpenClaw 会话文件。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeOpenClaw)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeOpenClaw: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include Hermes</span>
          <span className="settings-field-sub">{l("Indexes local Hermes session database.", "索引本地 Hermes 会话数据库。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeHermes)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeHermes: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include OpenCode</span>
          <span className="settings-field-sub">{l("Indexes local OpenCode sessions.", "索引本地 OpenCode 会话。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeOpenCode)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeOpenCode: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include ZCode</span>
          <span className="settings-field-sub">
            {l("Indexes local ZCode sessions read-only.", "以只读方式索引本地 ZCode 会话。")}
          </span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeZcode)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeZcode: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include Pi</span>
          <span className="settings-field-sub">
            {l("Indexes local Pi sessions from ~/.pi/agent/sessions.", "从 ~/.pi/agent/sessions 索引本地 Pi 会话。")}
          </span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includePi)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includePi: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include Cursor Agent</span>
          <span className="settings-field-sub">{l("Indexes local Cursor agent transcripts.", "索引本地 Cursor agent 记录。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeCursorAgent)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeCursorAgent: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include Trae</span>
          <span className="settings-field-sub">{l("Indexes local Trae session memory and enables open-state checks.", "索引本地 Trae 会话记忆，并支持打开状态检测。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeTrae)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeTrae: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include Qoder</span>
          <span className="settings-field-sub">{l("Indexes local Qoder conversation history.", "索引本地 Qoder 对话记录。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeQoder)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeQoder: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include Qoder IDE</span>
          <span className="settings-field-sub">
            {l(
              "Indexes legacy Qoder IDE conversations from ~/.qoder/cache/projects.",
              "索引 ~/.qoder/cache/projects 中的旧版 Qoder IDE 对话记录。",
            )}
          </span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeQoderIde)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeQoderIde: event.currentTarget.checked })}
        />
      </label>
      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">Include DeepSeek Harness</span>
          <span className="settings-field-sub">{l("Indexes local DeepSeek Harness (dsh) sessions from DSH_HOME (default: ~/.dsh).", "从 DSH_HOME（默认 ~/.dsh）索引本地 DeepSeek Harness（dsh）会话。")}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.includeDeepSeekCli)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ includeDeepSeekCli: event.currentTarget.checked })}
        />
      </label>
    </section>
  );
}
