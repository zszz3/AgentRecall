import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Beaker,
  Cloud,
  Folder,
  Gauge,
  Info,
  Keyboard,
  PackageSearch,
  Server,
  Sparkles,
  Sun,
  Terminal as TerminalIcon,
  UsersRound,
  X,
} from "lucide-react";
import type { AppUpdateProgress, AppUpdateStatus } from "../../../../core/app-update-types";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { RemoteHealthReport } from "../../../../core/remote-health";
import type { SessionSyncHookStatus } from "../../../../core/session-sync-queue";
import type { V1ImportResult } from "../../../../core/v1-import";
import type { SessionEnvironment } from "../../../../core/types";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import type { MessageFontSizeScale } from "../../message-font-size";
import type { ThemeMode } from "../../theme";
import { AboutSettings, useV1Import } from "./about-settings";
import { AiSummarySettings, useSummaryBatch } from "./ai-summary-settings";
import { AppearanceSettings } from "./appearance-settings";
import { ConnectionsSettings } from "./connections-settings";
import { EvalSettings } from "./eval-settings";
import { LegacyMemoryDataSettings } from "./legacy-memory-data-settings";
import { settlePendingSettings } from "./pending-settings";
import { RemoteSyncSettings } from "./remote-sync-settings";
import { ShortcutSettings } from "./shortcut-settings";
import { SkillsSettings } from "./skills-settings";
import { SourcesSettings } from "./sources-settings";
import { TeamSettings } from "./team-settings";
import { TerminalSettings } from "./terminal-settings";
import { UsageSettings } from "./usage-settings";

export type SettingsSection =
  | "team"
  | "terminal"
  | "shortcut"
  | "connections"
  | "sources"
  | "usage"
  | "ai"
  | "remote"
  | "skills"
  | "eval"
  | "appearance"
  | "about";

export function SettingsDialog({
  platform,
  initialSection,
  settings: persistedSettings,
  appUpdateStatus,
  appUpdateProgress,
  appUpdateBusy,
  appUpdateError,
  environments,
  environmentHealthReports,
  diagnosingEnvironmentId,
  theme,
  language,
  messageFontSize,
  feedback,
  onSettingsChange: persistSettings,
  onCheckAppUpdate,
  onInstallAppUpdate,
  onSkipAppUpdate,
  onThemeChange,
  onLanguageChange,
  onMessageFontSizeChange,
  sessionHookStatus,
  sessionHookBusy,
  onSessionHookChange,
  onRefreshEnvironment,
  onDiagnoseEnvironment,
  onDeleteEnvironment,
  onAddSsh,
  onAddWsl,
  onImportV1,
  onOpenApiConfig,
  onOpenAgentModel,
  gatewayModelLabel,
  onOpenRemoteSessions,
  onClose,
}: {
  platform: NodeJS.Platform;
  initialSection: SettingsSection;
  settings: AppSettings | null;
  appUpdateStatus: AppUpdateStatus | null;
  appUpdateProgress: AppUpdateProgress | null;
  appUpdateBusy: boolean;
  appUpdateError: string | null;
  environments: SessionEnvironment[];
  environmentHealthReports: Record<string, RemoteHealthReport>;
  diagnosingEnvironmentId: string | null;
  theme: ThemeMode;
  language: LanguageMode;
  messageFontSize: MessageFontSizeScale;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => Promise<void>;
  onCheckAppUpdate: () => void;
  onInstallAppUpdate: () => void;
  onSkipAppUpdate: (untilNextVersion: boolean) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onLanguageChange: (language: LanguageMode) => void;
  onMessageFontSizeChange: (scale: MessageFontSizeScale) => void;
  sessionHookStatus: SessionSyncHookStatus | null;
  sessionHookBusy: boolean;
  onSessionHookChange: (enabled: boolean) => void;
  onRefreshEnvironment: (environment: SessionEnvironment) => void;
  onDiagnoseEnvironment: (environment: SessionEnvironment) => void;
  onDeleteEnvironment: (environment: SessionEnvironment) => void;
  onAddSsh: () => void;
  onAddWsl?: () => void;
  onImportV1: () => Promise<V1ImportResult>;
  onOpenApiConfig: () => void;
  /** Leaves Settings for Gateway model setup. */
  onOpenAgentModel: () => void;
  gatewayModelLabel?: string | null;
  onOpenRemoteSessions: () => void;
  onClose: () => void;
}): ReactElement {
  const [pendingSettings, setPendingSettings] = useState<AppSettingsUpdate>({});
  const settings = persistedSettings ? { ...persistedSettings, ...pendingSettings } as AppSettings : null;
  const hasPendingSetting = (...keys: Array<keyof AppSettingsUpdate>): boolean =>
    keys.some((key) => Object.prototype.hasOwnProperty.call(pendingSettings, key));
  const saveSettings = async (next: AppSettingsUpdate): Promise<void> => {
    setPendingSettings((current) => ({ ...current, ...next }));
    try {
      await persistSettings(next);
    } finally {
      setPendingSettings((current) => settlePendingSettings(current, next));
    }
  };
  const onSettingsChange = (next: AppSettingsUpdate): void => {
    void saveSettings(next);
  };
  const summaryBatch = useSummaryBatch(language);
  const v1Import = useV1Import(language, onImportV1);
  const l = (en: string, zh: string) => localize(language, en, zh);
  const shouldSignalAppUpdate = Boolean(appUpdateStatus?.updateAvailable && !appUpdateStatus.updateSkipped && !appUpdateStatus.promptSnoozed);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const settingsContentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const content = settingsContentRef.current;
    if (!content) return;
    content.scrollTop = 0;
    const frame = window.requestAnimationFrame(() => {
      content.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, appUpdateStatus?.manifest?.version, appUpdateStatus?.updateAvailable]);

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Settings", "设置")}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="settings-shell">
          <nav className="settings-sidebar" aria-label={l("Settings sections", "设置分区")}>
            <button className={activeSection === "terminal" ? "active" : ""} onClick={() => setActiveSection("terminal")}>
              <TerminalIcon size={15} />
              <span>{l("Default terminal", "默认终端")}</span>
            </button>
            <button className={activeSection === "shortcut" ? "active" : ""} onClick={() => setActiveSection("shortcut")}>
              <Keyboard size={15} />
              <span>{l("Global shortcut", "全局快捷键")}</span>
            </button>
            <button className={activeSection === "team" ? "active" : ""} onClick={() => setActiveSection("team")}>
              <UsersRound size={15} /><span>{l("Team", "团队")}</span>
            </button>
            <button className={activeSection === "connections" ? "active" : ""} onClick={() => setActiveSection("connections")}>
              <Server size={15} />
              <span>{l("Connections", "连接")}</span>
            </button>
            <button className={activeSection === "sources" ? "active" : ""} onClick={() => setActiveSection("sources")}>
              <Folder size={15} />
              <span>{l("Optional sources", "可选来源")}</span>
            </button>
            <button className={activeSection === "usage" ? "active" : ""} onClick={() => setActiveSection("usage")}>
              <Gauge size={15} />
              <span>{l("Usage limits", "剩余额度")}</span>
            </button>
            <button className={activeSection === "ai" ? "active" : ""} onClick={() => setActiveSection("ai")}>
              <Sparkles size={15} />
              <span>{l("AI", "AI")}</span>
            </button>
            <button className={activeSection === "remote" ? "active" : ""} onClick={() => setActiveSection("remote")}>
              <Cloud size={15} />
              <span>{l("Remote sync", "远程同步")}</span>
            </button>
            <button className={activeSection === "skills" ? "active" : ""} onClick={() => setActiveSection("skills")}>
              <PackageSearch size={15} />
              <span>{l("Skills", "Skills")}</span>
            </button>
            <button className={activeSection === "eval" ? "active" : ""} onClick={() => setActiveSection("eval")}>
              <Beaker size={15} />
              <span>{l("Eval", "Eval")}</span>
            </button>
            <button className={activeSection === "appearance" ? "active" : ""} onClick={() => setActiveSection("appearance")}>
              <Sun size={15} />
              <span>{l("Appearance", "外观")}</span>
            </button>
            <button className={activeSection === "about" ? "active" : ""} onClick={() => setActiveSection("about")}>
              <Info size={15} />
              <span>{l("About", "关于")}</span>
              {shouldSignalAppUpdate ? <span className="settings-update-dot" aria-hidden="true" /> : null}
            </button>
          </nav>
          <div ref={settingsContentRef} className="settings-content">
            {activeSection === "team" ? <TeamSettings language={language} /> : null}
            {activeSection === "terminal" ? (
              <TerminalSettings
                language={language}
                platform={platform}
                settings={settings}
                saving={hasPendingSetting("defaultTerminal")}
                onSettingsChange={onSettingsChange}
              />
            ) : null}
            {activeSection === "shortcut" ? (
              <ShortcutSettings
                language={language}
                platform={platform}
                settings={settings}
                saving={hasPendingSetting("globalShortcut")}
                onSettingsChange={onSettingsChange}
              />
            ) : null}
            {activeSection === "connections" ? (
              <ConnectionsSettings
                language={language}
                platform={platform}
                environments={environments}
                environmentHealthReports={environmentHealthReports}
                diagnosingEnvironmentId={diagnosingEnvironmentId}
                onAddSsh={onAddSsh}
                onAddWsl={onAddWsl}
                onRefreshEnvironment={onRefreshEnvironment}
                onDiagnoseEnvironment={onDiagnoseEnvironment}
                onDeleteEnvironment={onDeleteEnvironment}
              />
            ) : null}
            {activeSection === "sources" ? (
              <SourcesSettings language={language} settings={settings} onSettingsChange={onSettingsChange} />
            ) : null}
            {activeSection === "usage" ? (
              <UsageSettings language={language} settings={settings} onSettingsChange={onSettingsChange} />
            ) : null}
            {activeSection === "ai" ? (
              <AiSummarySettings
                language={language}
                settings={settings}
                summaryBatch={summaryBatch}
                onSettingsChange={onSettingsChange}
                onOpenApiConfig={onOpenApiConfig}
              />
            ) : null}
            {activeSection === "ai" ? <LegacyMemoryDataSettings language={language} /> : null}
            {activeSection === "eval" ? (
              <EvalSettings
                language={language}
                settings={settings}
                saving={hasPendingSetting("evalEnabled")}
                onSettingsChange={onSettingsChange}
              />
            ) : null}
            {activeSection === "remote" ? (
              <RemoteSyncSettings
                language={language}
                settings={settings}
                hasPendingSetting={hasPendingSetting}
                sessionHookStatus={sessionHookStatus}
                sessionHookBusy={sessionHookBusy}
                onSettingsChange={onSettingsChange}
                onSessionHookChange={onSessionHookChange}
                onOpenRemoteSessions={onOpenRemoteSessions}
              />
            ) : null}
            {activeSection === "skills" ? (
              <SkillsSettings
                language={language}
                settings={settings}
                gatewayModelLabel={gatewayModelLabel}
                hasPendingSetting={hasPendingSetting}
                onSettingsChange={onSettingsChange}
                onOpenAgentModel={onOpenAgentModel}
              />
            ) : null}
            {activeSection === "appearance" ? (
              <AppearanceSettings
                language={language}
                platform={platform}
                settings={settings}
                theme={theme}
                messageFontSize={messageFontSize}
                onThemeChange={onThemeChange}
                onLanguageChange={onLanguageChange}
                onMessageFontSizeChange={onMessageFontSizeChange}
                onSettingsChange={onSettingsChange}
              />
            ) : null}
            {activeSection === "about" ? (
              <AboutSettings
                language={language}
                settings={settings}
                appUpdateStatus={appUpdateStatus}
                appUpdateProgress={appUpdateProgress}
                appUpdateBusy={appUpdateBusy}
                appUpdateError={appUpdateError}
                shouldSignalAppUpdate={shouldSignalAppUpdate}
                v1Import={v1Import}
                onSettingsChange={onSettingsChange}
                onCheckAppUpdate={onCheckAppUpdate}
                onInstallAppUpdate={onInstallAppUpdate}
                onSkipAppUpdate={onSkipAppUpdate}
              />
            ) : null}
          </div>
        </div>
        <div className={`settings-feedback ${feedback?.kind ?? ""}`} aria-live="polite">
          {feedback?.message ?? ""}
        </div>
      </section>
    </div>
  );
}
