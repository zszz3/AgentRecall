import { useState } from "react";
import type { ReactElement } from "react";
import { CheckCircle2, ChevronRight, Download, Info, RefreshCw, Sparkles, Wrench } from "lucide-react";

import appIconUrl from "../../../../../assets/app-icon.png";
import type { AppUpdateProgress, AppUpdateStatus } from "../../../../core/app-update-types";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { V1ImportResult } from "../../../../core/v1-import";
import { localize, type LanguageMode } from "../../language";

interface V1ImportState {
  running: boolean;
  kind: "success" | "error" | null;
  message: string | null;
}

export interface V1Import extends V1ImportState {
  run: () => Promise<void>;
}

/**
 * Imports V1 data. The Settings dialog holds this state instead of the About section so an import in flight
 * keeps its disabled button and result message when the user switches sections and returns.
 */
export function useV1Import(language: LanguageMode, onImportV1: () => Promise<V1ImportResult>): V1Import {
  const [v1ImportState, setV1ImportState] = useState<V1ImportState>({ running: false, kind: null, message: null });
  const l = (en: string, zh: string) => localize(language, en, zh);

  async function run(): Promise<void> {
    setV1ImportState({ running: true, kind: null, message: l("Importing V1 data...", "正在导入 V1 数据...") });
    try {
      const result = await onImportV1();
      const imported = l(
        `Imported ${result.importedSessions} cached sessions; kept ${result.skippedSessions} existing V2 sessions.`,
        `已导入 ${result.importedSessions} 个缓存会话，保留 ${result.skippedSessions} 个已有 V2 会话。`,
      );
      const extras = l(
        ` Session settings, ${result.importedEnvironments} connections, and ${result.importedSyncBindings} cloud bindings were migrated.`,
        ` 同时迁移了会话设置、${result.importedEnvironments} 个连接和 ${result.importedSyncBindings} 个云端同步关系。`,
      );
      const failures = result.failedSessions > 0
        ? l(` ${result.failedSessions} sessions failed.`, ` ${result.failedSessions} 个会话导入失败。`)
        : "";
      setV1ImportState({ running: false, kind: result.failedSessions > 0 ? "error" : "success", message: imported + extras + failures });
    } catch (error) {
      setV1ImportState({ running: false, kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { ...v1ImportState, run };
}

function UpdateReleaseSection({
  kind,
  title,
  items,
}: {
  kind: "features" | "fixes";
  title: string;
  items: string[];
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <section className={`update-release-section ${kind}`}>
      <div className="update-release-section-title">
        <span className="update-release-section-icon" aria-hidden="true">
          {kind === "features" ? <Sparkles size={15} /> : <Wrench size={15} />}
        </span>
        <strong>{title}</strong>
      </div>
      <ul>{items.map((item) => <li key={`${kind}:${item}`}>{item}</li>)}</ul>
    </section>
  );
}

function updateProgressLabel(progress: AppUpdateProgress, language: LanguageMode): string {
  switch (progress.phase) {
    case "downloading":
      return localize(language, "Downloading update", "正在下载更新");
    case "verifying":
      return localize(language, "Verifying download", "正在校验下载文件");
    case "staging":
      return localize(language, "Installing to staging area", "正在安装到临时目录");
    case "validating":
      return localize(language, "Validating application", "正在验证应用");
    case "restarting":
      return localize(language, "Restarting application", "正在重新启动");
    case "completed":
      return localize(language, "Update complete", "更新完成");
    case "error":
      return localize(language, "Update failed", "更新失败");
    default:
      return localize(language, "Checking for updates", "正在检查更新");
  }
}

export function AboutSettings({
  language,
  settings,
  appUpdateStatus,
  appUpdateProgress,
  appUpdateBusy,
  appUpdateError,
  shouldSignalAppUpdate,
  v1Import,
  onSettingsChange,
  onCheckAppUpdate,
  onInstallAppUpdate,
  onSkipAppUpdate,
}: {
  language: LanguageMode;
  settings: AppSettings | null;
  appUpdateStatus: AppUpdateStatus | null;
  appUpdateProgress: AppUpdateProgress | null;
  appUpdateBusy: boolean;
  appUpdateError: string | null;
  /** True while an update is available and the user has neither skipped nor snoozed it. */
  shouldSignalAppUpdate: boolean;
  v1Import: V1Import;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onCheckAppUpdate: () => void;
  onInstallAppUpdate: () => void;
  onSkipAppUpdate: (untilNextVersion: boolean) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const appUpdateSuppressed = Boolean(appUpdateStatus?.updateAvailable && !shouldSignalAppUpdate);

  return (
    <section className="settings-pane update-about-pane">
      <div className="update-app-identity">
        <img className="update-brand-mark" src={appIconUrl} alt="" />
        <h3>AgentRecall</h3>
        <p>
          {appUpdateStatus?.developmentBuild
            ? `${l("Development build", "开发版本")} · v${appUpdateStatus.currentVersion}`
            : `v${appUpdateStatus?.currentVersion ?? "0.0.0"}`}
        </p>
      </div>

      {appUpdateStatus?.developmentBuild ? (
        <div className="update-current-state development">
          <span className="update-state-icon" aria-hidden="true">
            <Info size={19} />
          </span>
          <span className="update-state-copy">
            <strong>{l("Running from source", "正在从源码运行")}</strong>
            <span>{l("Release updates are disabled while running from source.", "从源码运行时不检查或安装正式版本更新。")}</span>
          </span>
        </div>
      ) : shouldSignalAppUpdate && appUpdateStatus?.manifest ? (
        <div className="update-available-card">
          <div className="update-available-head">
            <div className="update-available-copy">
              <span>{l("Update available", "发现新版本")}</span>
              <div className="update-version-route" aria-label={l(`Version ${appUpdateStatus.currentVersion} to ${appUpdateStatus.manifest.version}`, `版本 ${appUpdateStatus.currentVersion} 更新至 ${appUpdateStatus.manifest.version}`)}>
                <span>v{appUpdateStatus.currentVersion}</span>
                <ChevronRight size={18} aria-hidden="true" />
                <strong>v{appUpdateStatus.manifest.version}</strong>
                <span className="update-new-badge">{l("NEW", "可更新")}</span>
              </div>
            </div>
            <span className="update-available-icon" aria-hidden="true">
              <Sparkles size={22} />
            </span>
          </div>
          <div className="update-release-card">
            <UpdateReleaseSection kind="features" title={l("New features", "新增功能")} items={appUpdateStatus.manifest.notes.features} />
            <UpdateReleaseSection kind="fixes" title={l("Fixes", "问题修复")} items={appUpdateStatus.manifest.notes.fixes} />
          </div>
          {appUpdateProgress ? (
            <div className="update-progress-panel" role="status" aria-live="polite">
              <div className="update-progress-copy">
                <strong>{updateProgressLabel(appUpdateProgress, language)}</strong>
                {typeof appUpdateProgress.percent === "number" ? <span>{appUpdateProgress.percent}%</span> : null}
              </div>
              <div className={`update-progress-track ${typeof appUpdateProgress.percent === "number" ? "" : "indeterminate"}`}>
                <span style={typeof appUpdateProgress.percent === "number" ? { width: `${appUpdateProgress.percent}%` } : undefined} />
              </div>
              {appUpdateProgress.message ? <small>{appUpdateProgress.message}</small> : null}
            </div>
          ) : null}
          <div className="update-card-footer">
            <span>{l("The App will reopen automatically after updating.", "更新完成后会自动重新打开应用。")}</span>
            <div className="update-card-actions">
              <button
                type="button"
                className="update-refresh-button"
                disabled={appUpdateBusy}
                onClick={onCheckAppUpdate}
                aria-label={l("Check again", "重新检查更新")}
                title={l("Check again", "重新检查更新")}
              >
                <RefreshCw size={15} className={appUpdateBusy ? "spin" : ""} />
              </button>
              <button type="button" className="update-secondary-button" disabled={appUpdateBusy} onClick={() => onSkipAppUpdate(false)}>
                {l("Skip", "跳过")}
              </button>
              <button type="button" className="update-secondary-button" disabled={appUpdateBusy} onClick={() => onSkipAppUpdate(true)}>
                {l("Skip until next", "跳过至下版")}
              </button>
              <button type="button" className="update-primary-button" disabled={appUpdateBusy} onClick={onInstallAppUpdate}>
                <Download size={15} aria-hidden="true" />
                {appUpdateBusy ? l("Preparing...", "准备中...") : l("Update now", "立即更新")}
              </button>
            </div>
          </div>
          {appUpdateError || appUpdateStatus.error ? <div className="update-card-error">{appUpdateError || appUpdateStatus.error}</div> : null}
        </div>
      ) : (
        <div
          className={`update-current-state ${
            appUpdateError || appUpdateStatus?.error ? "error" : appUpdateBusy ? "checking" : "latest"
          }`}
        >
          <span className="update-state-icon" aria-hidden="true">
            {appUpdateBusy ? <RefreshCw size={19} className="spin" /> : appUpdateError || appUpdateStatus?.error ? <Info size={19} /> : <CheckCircle2 size={20} />}
          </span>
          <span className="update-state-copy">
            <strong>
              {appUpdateBusy
                ? l("Checking for updates...", "正在检查更新...")
                : appUpdateError || appUpdateStatus?.error || (appUpdateSuppressed ? l("Update prompt skipped", "已跳过此次更新提示") : l("You're up to date", "当前已是最新版本"))}
            </strong>
            {!appUpdateBusy && !appUpdateError && !appUpdateStatus?.error ? (
              <span>
                {appUpdateSuppressed
                  ? l("Use Check for updates to show the skipped release again.", "点击检查更新可重新显示已跳过的版本。")
                  : l("Automatic checks will keep you on the newest release.", "自动检查会让你及时获取后续新版本。")}
              </span>
            ) : null}
          </span>
        </div>
      )}

      {!appUpdateStatus?.developmentBuild && !shouldSignalAppUpdate ? (
        <div className="update-about-actions">
          <button type="button" className="settings-action-button" disabled={appUpdateBusy} onClick={onCheckAppUpdate}>
            <RefreshCw size={14} className={appUpdateBusy ? "spin" : ""} />
            {l("Check for updates", "检查更新")}
          </button>
        </div>
      ) : null}
      {!appUpdateStatus?.developmentBuild ? (
        <label className="settings-field settings-toggle update-auto-check">
          <div className="settings-field-text">
            <span className="settings-field-title">{l("Automatically check for updates", "自动检查更新")}</span>
            <span className="settings-field-sub">{l("The terminal and App check for a new version once a day.", "终端与 App 每天自动检查一次新版本。")}</span>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={Boolean(settings?.autoCheckUpdates)}
            disabled={!settings}
            onChange={(event) => onSettingsChange({ autoCheckUpdates: event.currentTarget.checked })}
          />
        </label>
      ) : null}
      <div className="update-v1-import">
        <div className="v1-import-card">
          <div className="v1-import-copy">
            <strong>{l("V1 data migration", "V1 数据迁移")}</strong>
            <span>{l(
              "Import V1 session settings, connections, cached conversations, user labels, and cloud bindings. Existing V2 conversations are kept, and saved passwords are not copied.",
              "导入 V1 的会话设置、连接、缓存对话、用户标记和云端同步关系；已有 V2 会话会被保留，已保存的密码不会复制。",
            )}</span>
          </div>
          <button
            type="button"
            className="settings-action-button v1-import-button"
            disabled={v1Import.running}
            onClick={() => void v1Import.run()}
          >
            {v1Import.running ? <RefreshCw size={14} className="spin" /> : <Download size={14} />}
            {v1Import.running ? l("Importing...", "正在导入...") : l("Import V1 data", "一键导入 V1 数据")}
          </button>
        </div>
        {v1Import.message ? (
          <div className={`v1-import-result ${v1Import.kind ?? ""}`} role="status" aria-live="polite">
            {v1Import.message}
          </div>
        ) : null}
      </div>
    </section>
  );
}
