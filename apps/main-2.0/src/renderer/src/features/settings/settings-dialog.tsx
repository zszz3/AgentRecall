import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Activity,
  Beaker,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Container,
  Download,
  Folder,
  Gauge,
  GitBranch,
  Info,
  Keyboard,
  Languages,
  Laptop,
  Moon,
  PackageSearch,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Sun,
  Terminal as TerminalIcon,
  Trash2,
  Type,
  Wrench,
  X,
} from "lucide-react";
import appIconUrl from "../../../../../assets/app-icon.png";
import type { AppUpdateProgress, AppUpdateStatus } from "../../../../core/app-update-types";
import { formatRelativeTime } from "../../../../core/format-session";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { AgentChannel } from "../../../../automation/contracts";
import type { RemoteHealthReport } from "../../../../core/remote-health";
import type { SessionSyncHookStatus } from "../../../../core/session-sync-queue";
import type { V1ImportResult } from "../../../../core/v1-import";
import { globalShortcutOptions } from "../../../../core/shortcuts";
import { terminalSelectOptions } from "../../../../core/terminal-options";
import type { SessionEnvironment } from "../../../../core/types";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import { SupabaseSetupGuide } from "../../components/supabase-setup-guide";
import {
  MESSAGE_FONT_SIZE_SCALES,
  type MessageFontSizeScale,
} from "../../message-font-size";
import type { ThemeMode } from "../../theme";
import {
  environmentStatus,
  environmentStatusLabel,
  environmentTarget,
} from "../environments/environment-display";
import { OpenVikingMemorySettings } from "./openviking-memory-settings";
import { EvalSettings } from "./eval-settings";

export type SettingsSection =
  | "terminal"
  | "shortcut"
  | "connections"
  | "sources"
  | "usage"
  | "ai"
  | "memory"
  | "remote"
  | "skills"
  | "eval"
  | "workflow"
  | "appearance"
  | "about";

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

export function SettingsDialog({
  platform,
  initialSection,
  settings: persistedSettings,
  runtimeChannels,
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
  onOpenRemoteSessions,
  onClose,
}: {
  platform: NodeJS.Platform;
  initialSection: SettingsSection;
  settings: AppSettings | null;
  runtimeChannels: AgentChannel[];
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
  onOpenRemoteSessions: () => void;
  onClose: () => void;
}): ReactElement {
  const [pendingSettings, setPendingSettings] = useState<AppSettingsUpdate>({});
  const settings = persistedSettings ? { ...persistedSettings, ...pendingSettings } as AppSettings : null;
  const defaultTerminal = settings?.defaultTerminal ?? (platform === "win32" ? "WindowsTerminal" : "Terminal");
  const globalShortcut = settings?.globalShortcut ?? (platform === "win32" ? "Ctrl+Alt+Space" : "Alt+Space");
  const hasPendingSetting = (...keys: Array<keyof AppSettingsUpdate>): boolean =>
    keys.some((key) => Object.prototype.hasOwnProperty.call(pendingSettings, key));
  const saveSettings = async (next: AppSettingsUpdate): Promise<void> => {
    const keys = Object.keys(next) as Array<keyof AppSettingsUpdate>;
    setPendingSettings((current) => ({ ...current, ...next }));
    try {
      await persistSettings(next);
    } finally {
      setPendingSettings((current) => {
        const updated = { ...current } as Record<string, unknown>;
        const submitted = next as Record<string, unknown>;
        for (const key of keys) {
          if (updated[key] === submitted[key]) delete updated[key];
        }
        return updated as AppSettingsUpdate;
      });
    }
  };
  const onSettingsChange = (next: AppSettingsUpdate): void => {
    void saveSettings(next);
  };
  const [summaryBatch, setSummaryBatch] = useState<{ running: boolean; message: string | null }>({ running: false, message: null });
  const [mcpEnabled, setMcpEnabled] = useState<boolean | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [workflowMcpEnabled, setWorkflowMcpEnabled] = useState<boolean | null>(null);
  const [workflowMcpBusy, setWorkflowMcpBusy] = useState(false);
  const [v1ImportState, setV1ImportState] = useState<{
    running: boolean;
    kind: "success" | "error" | null;
    message: string | null;
  }>({ running: false, kind: null, message: null });

  useEffect(() => {
    void window.sessionSearch
      .getMcpStatus()
      .then(setMcpEnabled)
      .catch(() => setMcpEnabled(false));
    void window.sessionSearch
      .getWorkflowMcpStatus()
      .then(setWorkflowMcpEnabled)
      .catch(() => setWorkflowMcpEnabled(false));
  }, []);

  async function toggleMcp(next: boolean): Promise<void> {
    setMcpBusy(true);
    try {
      setMcpEnabled(await window.sessionSearch.setMcpEnabled(next));
    } catch {
      // Leave the previous state; the toggle simply won't flip.
    } finally {
      setMcpBusy(false);
    }
  }

  async function toggleWorkflowMcp(next: boolean): Promise<void> {
    setWorkflowMcpBusy(true);
    try {
      setWorkflowMcpEnabled(await window.sessionSearch.setWorkflowMcpEnabled(next));
    } catch {
      // Leave the previous state; the toggle simply won't flip.
    } finally {
      setWorkflowMcpBusy(false);
    }
  }

  async function importV1Data(): Promise<void> {
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

  useEffect(() => {
    const off = window.sessionSearch.onSummaryProgress((progress) => {
      setSummaryBatch((current) =>
        current.running
          ? {
              running: true,
              message: localize(
                language,
                `Summarizing ${progress.processed + progress.failed}/${progress.total}...`,
                `摘要中 ${progress.processed + progress.failed}/${progress.total}...`,
              ),
            }
          : current,
      );
    });
    return off;
  }, [language]);

  async function runSummaryBatch(): Promise<void> {
    setSummaryBatch({ running: true, message: localize(language, "Starting...", "开始...") });
    try {
      const result = await window.sessionSearch.summarizeMissingSessions();
      const base = localize(language, `Summarized ${result.processed}/${result.total} sessions.`, `已摘要 ${result.processed}/${result.total} 个会话。`);
      const failedNote = result.failed > 0 ? localize(language, ` ${result.failed} failed.`, ` ${result.failed} 个失败。`) : "";
      setSummaryBatch({ running: false, message: base + failedNote });
    } catch (error) {
      setSummaryBatch({ running: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const l = (en: string, zh: string) => localize(language, en, zh);
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
  const shouldSignalAppUpdate = Boolean(appUpdateStatus?.updateAvailable && !appUpdateStatus.updateSkipped && !appUpdateStatus.promptSnoozed);
  const appUpdateSuppressed = Boolean(appUpdateStatus?.updateAvailable && !shouldSignalAppUpdate);
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
            <button className={activeSection === "memory" ? "active" : ""} onClick={() => setActiveSection("memory")}>
              <BrainCircuit size={15} />
              <span>{l("Memory", "记忆")}</span>
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
            <button className={activeSection === "workflow" ? "active" : ""} onClick={() => setActiveSection("workflow")}>
              <GitBranch size={15} />
              <span>Workflow</span>
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
            {activeSection === "terminal" ? (
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
                    disabled={!settings || hasPendingSetting("defaultTerminal")}
                    onChange={(event) => void saveSettings({ defaultTerminal: event.target.value as AppSettings["defaultTerminal"] })}
                  >
                    {terminalSelectOptions(platform).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            ) : null}
            {activeSection === "shortcut" ? (
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
                    disabled={!settings || hasPendingSetting("globalShortcut")}
                    onChange={(event) => void saveSettings({ globalShortcut: event.target.value as AppSettings["globalShortcut"] })}
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
            ) : null}
            {activeSection === "connections" ? (
              <section className="settings-pane connections-pane">
                <header className="settings-pane-head settings-pane-head-row">
                  <div>
                    <h3>{l("Connections", "连接")}</h3>
                    <p>{l("Local, WSL, and SSH environments indexed by session search.", "会话搜索索引的本地、WSL 和 SSH 环境。")}</p>
                  </div>
                  {platform === "win32" && onAddWsl ? (
                    <button className="settings-action-button" onClick={onAddWsl}>
                      <Container size={14} />
                      <span>{l("Add WSL", "添加 WSL")}</span>
                    </button>
                  ) : null}
                  <button className="settings-action-button" onClick={onAddSsh}>
                    <Plus size={14} />
                    <span>{l("Add SSH", "添加 SSH")}</span>
                  </button>
                </header>
                <div className="connection-list">
                  {environments.map((environment) => {
                    const report = environmentHealthReports[environment.id];
                    const diagnosing = diagnosingEnvironmentId === environment.id;
                    return (
                      <div key={environment.id} className={`connection-row ${environmentStatus(environment)} ${report ? "with-diagnostics" : ""}`}>
                        <div className="connection-icon">{environment.kind === "local" ? <Laptop size={15} /> : environment.kind === "wsl" ? <Container size={15} /> : <Server size={15} />}</div>
                        <div className="connection-main">
                          <span className="connection-title">{environment.label}</span>
                          <span className="connection-target">{environmentTarget(environment, language)}</span>
                          {environment.lastError ? <span className="connection-error">{environment.lastError}</span> : null}
                        </div>
                        <span className="connection-status">{environmentStatusLabel(environment, language)}</span>
                        {environment.kind !== "local" ? (
                          <div className="connection-actions">
                            <button
                              className="icon-button"
                              disabled={diagnosing}
                              onClick={() => onDiagnoseEnvironment(environment)}
                              title={l("Diagnose", "诊断")}
                              aria-label={l(`Diagnose ${environment.label}`, `诊断 ${environment.label}`)}
                            >
                              <Activity size={14} />
                            </button>
                            <button
                              className="icon-button"
                              onClick={() => onRefreshEnvironment(environment)}
                              title={l("Refresh", "刷新")}
                              aria-label={l(`Refresh ${environment.label}`, `刷新 ${environment.label}`)}
                            >
                              <RefreshCw size={14} />
                            </button>
                            <button
                              className="icon-button danger"
                              onClick={() => onDeleteEnvironment(environment)}
                              title={l("Delete", "删除")}
                              aria-label={l(`Delete ${environment.label}`, `删除 ${environment.label}`)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ) : null}
                        {report ? (
                          <div className="connection-diagnostics">
                            <div className="connection-diagnostics-head">
                              <span>{report.summary}</span>
                              <time>{formatRelativeTime(report.checkedAt, language)}</time>
                            </div>
                            <div className="connection-diagnostic-list">
                              {report.checks.map((check) => (
                                <div key={check.id} className={`connection-diagnostic-check ${check.status}`}>
                                  <span className="connection-diagnostic-dot" />
                                  <span className="connection-diagnostic-label">{check.label}</span>
                                  <span className="connection-diagnostic-message" title={check.detail ?? check.message}>
                                    {check.message}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
            {activeSection === "sources" ? (
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
                      {l("Indexes local Pi sessions read-only.", "以只读方式索引本地 Pi 会话。")}
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
            ) : null}
            {activeSection === "usage" ? (
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
            ) : null}
            {activeSection === "ai" ? (
              <section className="settings-pane">
                <header className="settings-pane-head settings-pane-head-row">
                  <div>
                    <h3>{l("AI summaries", "AI 摘要")}</h3>
                    <p>
                      {l(
                        "Generate a one-line searchable summary per session. Configure the provider and API key under the AI Summary tab of the API dialog (falls back to the Codex provider). Session content is sent to that provider.",
                        "为每个会话生成一句可搜索的摘要。在 API 弹窗的「AI 摘要」标签里配置 provider 和 API key(未配则回落 Codex provider)。会话内容会发送给该 provider。",
                      )}
                    </p>
                  </div>
                  <button type="button" className="settings-action-button" onClick={onOpenApiConfig}>
                    {l("Configure provider", "配置 provider")}
                  </button>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Auto-summarize new sessions", "自动摘要新会话")}</span>
                    <span className="settings-field-sub">{l("After each index, summarize recent sessions that are missing or outdated.", "每次索引后，为缺失或已过期的近期会话生成摘要。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.summaryAutoBackfill)}
                    disabled={!settings}
                    onChange={(event) => onSettingsChange({ summaryAutoBackfill: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Only summarize sessions newer than (days)", "只摘要近 N 天内的会话")}</span>
                    <span className="settings-field-sub">{l("Older inactive sessions are skipped by auto/batch summary.", "更久未更新的会话不会被自动/批量摘要。")}</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    className="settings-number"
                    value={settings?.summaryMaxAgeDays ?? 30}
                    disabled={!settings}
                    onChange={(event) => onSettingsChange({ summaryMaxAgeDays: Number(event.currentTarget.value) })}
                  />
                </label>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Migration compression concurrency", "迁移压缩并发度")}</span>
                    <span className="settings-field-sub">{l("Max chunk summaries run in parallel when compressing a long session for migration. Lower it if you hit provider rate limits.", "迁移压缩长会话时分片摘要的最大并行数。遇到 provider 限流就调低。")}</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    max={32}
                    className="settings-number"
                    value={settings?.compressionConcurrency ?? 8}
                    disabled={!settings}
                    onChange={(event) => onSettingsChange({ compressionConcurrency: Number(event.currentTarget.value) })}
                  />
                </label>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Complete migration threshold", "完整迁移阈值")}</span>
                    <span className="settings-field-sub">{l("Sessions within this estimated size migrate without compression. Unit: K Token.", "估算大小不超过该值时完整迁移。单位：K Token。")}</span>
                  </div>
                  <input
                    type="number"
                    min={10}
                    max={1000}
                    step={10}
                    className="settings-number"
                    value={(settings?.migrationCompleteTokenLimit ?? 100_000) / 1_000}
                    disabled={!settings}
                    onChange={(event) => onSettingsChange({
                      migrationCompleteTokenLimit: Number(event.currentTarget.value) * 1_000,
                    })}
                  />
                </label>
                <div className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Backfill missing summaries now", "立即补全缺失摘要")}</span>
                    <span className="settings-field-sub">{summaryBatch.message ?? l("Summarize recent sessions that have no summary yet.", "为还没有摘要的近期会话批量生成。")}</span>
                  </div>
                  <button className="settings-action-button" disabled={!settings || summaryBatch.running} onClick={() => void runSummaryBatch()}>
                    {summaryBatch.running ? l("Summarizing...", "摘要中...") : l("Run", "运行")}
                  </button>
                </div>
                <header className="settings-pane-head" style={{ marginTop: 18 }}>
                  <h3>{l("MCP server", "MCP 服务")}</h3>
                  <p>
                    {l(
                      "Manage MCP servers that expose AgentRecall capabilities to your CLI agents. Restart the CLI to apply config changes.",
                      "管理暴露给 CLI Agent 的 AgentRecall 能力 MCP。修改配置后重启对应 CLI 生效。",
                    )}
                  </p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Enable session search MCP", "启用会话检索 MCP")}</span>
                    <span className="settings-field-sub">
                      {mcpEnabled === null
                        ? l("Checking...", "检查中...")
                        : l("Registers in Claude Code, Codex, and CodeBuddy configs.", "注册到 Claude Code、Codex、CodeBuddy 的配置中。")}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(mcpEnabled)}
                    disabled={mcpEnabled === null || mcpBusy}
                    onChange={(event) => void toggleMcp(event.currentTarget.checked)}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Enable workflow MCP", "启用工作流 MCP")}</span>
                    <span className="settings-field-sub">
                      {workflowMcpEnabled === null
                        ? l("Checking...", "检查中...")
                        : l("Default off. Registers the workflow MCP for configured Codex Agents.", "默认关闭。启用后为已配置的 Codex Agent 注册工作流 MCP。")}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(workflowMcpEnabled)}
                    disabled={workflowMcpEnabled === null || workflowMcpBusy}
                    onChange={(event) => void toggleWorkflowMcp(event.currentTarget.checked)}
                  />
                </label>
              </section>
            ) : null}
            {activeSection === "memory" ? (
              <OpenVikingMemorySettings
                language={language}
                settings={settings}
                saving={hasPendingSetting("openVikingMemoryEnabled", "openVikingClaudeEnabled", "openVikingCodexEnabled", "openVikingOpenCodeEnabled")}
                onSettingsChange={onSettingsChange}
              />
            ) : null}
            {activeSection === "eval" ? (
              <EvalSettings
                language={language}
                settings={settings}
                saving={hasPendingSetting("evalEnabled")}
                onSettingsChange={onSettingsChange}
              />
            ) : null}
            {activeSection === "remote" ? (
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
            ) : null}
            {activeSection === "skills" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>{l("AI Skill exploration", "AI Skill 探索")}</h3>
                  <p>{l(
                    "Choose which configured Runtime understands natural-language requests before searching skills.sh.",
                    "选择由哪个已配置的 Runtime 理解自然语言需求，再搜索 skills.sh。",
                  )}</p>
                </header>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Exploration Runtime", "探索 Runtime")}</span>
                    <span className="settings-field-sub">{l(
                      "Automatic uses the first available Runtime. The request is executed through the same Runtime stack as Chat and Workflow.",
                      "自动模式使用第一个可用 Runtime；探索请求与 Chat、Workflow 共用同一套 Runtime 执行链路。",
                    )}</span>
                  </div>
                  <select
                    value={settings?.skillAiRuntimeId ?? ""}
                    disabled={!settings}
                    onChange={(event) => onSettingsChange({ skillAiRuntimeId: event.currentTarget.value })}
                  >
                    <option value="">{l("Automatic (first available)", "自动（第一个可用 Runtime）")}</option>
                    {settings?.skillAiRuntimeId
                      && !runtimeChannels.some((channel) => channel.id === settings.skillAiRuntimeId)
                      ? <option value={settings.skillAiRuntimeId}>{l("Missing Runtime", "已删除的 Runtime")} · {settings.skillAiRuntimeId}</option>
                      : null}
                    {runtimeChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>{channel.label} · {channel.agentId}</option>
                    ))}
                  </select>
                </label>
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
            ) : null}
            {activeSection === "workflow" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>Workflow</h3>
                  <p>{l("Control workflow review before and during execution independently.", "分别控制工作流运行前和运行中的审查能力。")}</p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Global Review", "全局 Review")}</span>
                    <span className="settings-field-sub">
                      {l(
                        "Show the adversarial review action for user workflows before they run.",
                        "为用户 Workflow 显示运行前的对抗审查入口。",
                      )}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.workflowGlobalReviewEnabled)}
                    disabled={!settings}
                    onChange={(event) => onSettingsChange({ workflowGlobalReviewEnabled: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Runtime Review", "运行时 Review")}</span>
                    <span className="settings-field-sub">
                      {l(
                        "Review configured critical Agent nodes in user workflows and retry results that miss their quality threshold.",
                        "用户 Workflow 运行时审查已配置的关键节点，未达到质量门槛时自动重试。",
                      )}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.workflowRuntimeReviewEnabled)}
                    disabled={!settings}
                    onChange={(event) => onSettingsChange({ workflowRuntimeReviewEnabled: event.currentTarget.checked })}
                  />
                </label>
              </section>
            ) : null}
            {activeSection === "appearance" ? (
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
            ) : null}
            {activeSection === "about" ? (
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
                      disabled={v1ImportState.running}
                      onClick={() => void importV1Data()}
                    >
                      {v1ImportState.running ? <RefreshCw size={14} className="spin" /> : <Download size={14} />}
                      {v1ImportState.running ? l("Importing...", "正在导入...") : l("Import V1 data", "一键导入 V1 数据")}
                    </button>
                  </div>
                  {v1ImportState.message ? (
                    <div className={`v1-import-result ${v1ImportState.kind ?? ""}`} role="status" aria-live="polite">
                      {v1ImportState.message}
                    </div>
                  ) : null}
                </div>
              </section>
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

function SettingsTextInput({
  type,
  value,
  disabled,
  placeholder,
  onCommit,
}: {
  type: "text" | "password";
  value: string;
  disabled: boolean;
  placeholder: string;
  onCommit: (value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const commit = (): void => {
    focusedRef.current = false;
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      type={type}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onFocus={() => {
        focusedRef.current = true;
        cancelledRef.current = false;
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelledRef.current = true;
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
