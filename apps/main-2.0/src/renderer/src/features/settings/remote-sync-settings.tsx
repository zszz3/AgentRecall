import type { ReactElement } from "react";

import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { SessionSyncHookStatus } from "../../../../core/session-sync-queue";
import { localize, type LanguageMode } from "../../language";
import { SupabaseSetupGuide } from "../../components/supabase-setup-guide";
import { SettingsTextInput } from "./settings-text-input";

export function RemoteSyncSettings({
  language,
  settings,
  hasPendingSetting,
  sessionHookStatus,
  sessionHookBusy,
  onSettingsChange,
  onSessionHookChange,
  onOpenRemoteSessions,
}: {
  language: LanguageMode;
  settings: AppSettings | null;
  hasPendingSetting: (...keys: Array<keyof AppSettingsUpdate>) => boolean;
  sessionHookStatus: SessionSyncHookStatus | null;
  sessionHookBusy: boolean;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onSessionHookChange: (enabled: boolean) => void;
  onOpenRemoteSessions: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const sessionHookSummary = sessionHookStatus === null
    ? l("Checking Hook status...", "正在检查 Hook 状态...")
    : sessionHookStatus.installed
      ? l(
          `Claude Code and Codex Hooks installed${sessionHookStatus.pending > 0 ? ` · ${sessionHookStatus.pending} pending` : ""}. Codex requires one-time trust from /hooks.`,
          `Claude Code 与 Codex Hook 已安装${sessionHookStatus.pending > 0 ? ` · ${sessionHookStatus.pending} 个待同步` : ""}。Codex 首次使用需在 /hooks 中确认信任。`,
        )
      : sessionHookStatus.claude || sessionHookStatus.codex
        ? l(
            `Partially installed: Claude ${sessionHookStatus.claude ? "on" : "off"}, Codex ${sessionHookStatus.codex ? "on" : "off"}.`,
            `Hook 仅部分安装：Claude ${sessionHookStatus.claude ? "已安装" : "未安装"}，Codex ${sessionHookStatus.codex ? "已安装" : "未安装"}。`,
          )
        : l("Not installed. Manual upload and restore remain available.", "尚未安装；仍可继续手动上传和恢复。");

  return (
    <section className="settings-pane">
      <header className="settings-pane-head settings-pane-head-row">
        <div>
          <h3>{l("Supabase remote sessions", "Supabase 远程会话")}</h3>
          <p>
            {l(
              "Use your own single-user Supabase project to upload sessions, search them on another device, view details, and restore them to Claude Code / Codex / CodeBuddy.",
              "使用你自己的单人 Supabase 项目上传会话，在另一台设备搜索、查看详情，并恢复到 Claude Code / Codex / CodeBuddy。",
            )}
          </p>
        </div>
        {settings?.remoteSyncEnabled ? (
          <button type="button" className="settings-action-button" disabled={hasPendingSetting("remoteSyncEnabled", "remoteSyncSupabaseUrl", "remoteSyncSupabaseAnonKey")} onClick={onOpenRemoteSessions}>
            {l("Session sync", "会话同步")}
          </button>
        ) : null}
      </header>
      <label className="settings-field">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("WSL polling fallback (seconds)", "WSL 轮询回退间隔（秒）")}</span>
          <span className="settings-field-sub">{l("Used when inotifywait/fswatch is unavailable or a distribution is restarting. 5–3600 seconds.", "监听工具不可用或发行版重启时使用。范围 5–3600 秒。")}</span>
        </div>
        <input
          type="number"
          min={5}
          max={3600}
          step={1}
          className="settings-number"
          value={Math.round((settings?.wslPollingIntervalMs ?? 60_000) / 1000)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ wslPollingIntervalMs: Number(event.currentTarget.value) * 1000 })}
        />
      </label>
      <label className="settings-field settings-toggle remote-sync-master-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Enable remote session sync", "启用远程会话同步")}</span>
          <span className="settings-field-sub">
            {l(
              "Upload and restore sessions with your Supabase project. Turning this off removes the session Hooks but keeps saved connection details and cloud data.",
              "使用你的 Supabase 项目上传和恢复会话。关闭后会移除会话 Hook，但保留连接信息和云端数据。",
            )}
          </span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={Boolean(settings?.remoteSyncEnabled)}
          disabled={!settings}
          onChange={(event) => onSettingsChange({ remoteSyncEnabled: event.currentTarget.checked })}
        />
      </label>
      {settings?.remoteSyncEnabled ? (
        <div className="remote-sync-settings-body">
          <label className="settings-field remote-sync-field">
            <div className="settings-field-text">
              <span className="settings-field-title">Supabase URL</span>
              <span className="settings-field-sub">https://your-project.supabase.co</span>
            </div>
            <SettingsTextInput
              type="text"
              value={settings.remoteSyncSupabaseUrl}
              disabled={hasPendingSetting("remoteSyncSupabaseUrl")}
              placeholder="https://your-project.supabase.co"
              onCommit={(value) => onSettingsChange({ remoteSyncSupabaseUrl: value })}
            />
          </label>
          <label className="settings-field remote-sync-field">
            <div className="settings-field-text">
              <span className="settings-field-title">anon key</span>
              <span className="settings-field-sub">{l("Stored locally. Do not commit this value to the repository.", "保存在本地，请不要提交到仓库。")}</span>
            </div>
            <SettingsTextInput
              type="password"
              value={settings.remoteSyncSupabaseAnonKey}
              disabled={hasPendingSetting("remoteSyncSupabaseAnonKey")}
              placeholder="eyJhbGciOi..."
              onCommit={(value) => onSettingsChange({ remoteSyncSupabaseAnonKey: value })}
            />
          </label>
          <label className="settings-field settings-toggle">
            <div className="settings-field-text">
              <span className="settings-field-title">{l("Sync session attachments", "同步会话附件")}</span>
              <span className="settings-field-sub">
                {l(
                  "Upload available attachments with remote sessions. Enabled by default.",
                  "远程同步会话时一并上传可用附件，默认开启。",
                )}
              </span>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={settings.syncSessionAttachments !== false}
              disabled={hasPendingSetting("syncSessionAttachments")}
              onChange={(event) => onSettingsChange({ syncSessionAttachments: event.currentTarget.checked })}
            />
          </label>
          <SupabaseSetupGuide
            language={language}
            tone="info"
            title={l("First-time setup", "首次配置")}
            message={l(
              "Copy the latest setup SQL, open this project's SQL Editor, and run it once before syncing.",
              "复制最新初始化 SQL，在当前项目的 SQL Editor 中执行一次，然后即可同步。",
            )}
            onCopySql={() => window.sessionSearch.copyCombinedSyncSetupSql()}
            onOpenSqlEditor={() => window.sessionSearch.openSupabaseSqlEditor("sessions")}
          />
          <div className="settings-field session-sync-hook-field">
            <div className="settings-field-text">
              <span className="settings-field-title">{l("Automatic session sync", "会话自动同步")}</span>
              <span className={`settings-field-sub${sessionHookStatus?.lastError ? " error" : ""}`}>
                {sessionHookStatus?.lastError ?? sessionHookSummary}
              </span>
            </div>
            <button
              type="button"
              className={`settings-action-button${sessionHookStatus?.installed ? " danger" : ""}`}
              disabled={sessionHookBusy || hasPendingSetting("remoteSyncEnabled", "remoteSyncSupabaseUrl", "remoteSyncSupabaseAnonKey") || !settings.remoteSyncSupabaseUrl || !settings.remoteSyncSupabaseAnonKey}
              onClick={() => onSessionHookChange(!sessionHookStatus?.installed)}
            >
              {sessionHookBusy
                ? l("Working...", "处理中...")
                : sessionHookStatus?.installed
                  ? l("Remove Hook", "移除 Hook")
                  : l("Install Hook", "安装 Hook")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
