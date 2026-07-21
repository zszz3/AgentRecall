import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Download,
  Folder,
  Gauge,
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
  Wrench,
  X,
} from "lucide-react";
import type { AppUpdateStatus } from "../../../../core/app-update-types";
import { formatRelativeTime } from "../../../../core/format-session";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { RemoteHealthReport } from "../../../../core/remote-health";
import type { SessionSyncHookStatus } from "../../../../core/session-sync-queue";
import { globalShortcutOptions } from "../../../../core/shortcuts";
import { terminalSelectOptions } from "../../../../core/terminal-options";
import type { SessionEnvironment } from "../../../../core/types";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import { SupabaseSetupGuide } from "../../components/supabase-setup-guide";
import type { ThemeMode } from "../../theme";
import {
  environmentStatus,
  environmentStatusLabel,
  environmentTarget,
} from "../environments/environment-display";

export type SettingsSection =
  | "terminal"
  | "shortcut"
  | "connections"
  | "sources"
  | "usage"
  | "ai"
  | "remote"
  | "skills"
  | "appearance"
  | "about";

function UpdateBrandMark(): ReactElement {
  return (
    <svg className="update-brand-mark" viewBox="0 0 96 96" aria-hidden="true">
      <defs>
        <linearGradient id="update-brand-gradient" x1="14" y1="8" x2="82" y2="88" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1687ff" />
          <stop offset="0.55" stopColor="#3d63ed" />
          <stop offset="1" stopColor="#7047d7" />
        </linearGradient>
        <radialGradient id="update-brand-glow" cx="0" cy="0" r="1" gradientTransform="translate(25 20) rotate(46) scale(69)">
          <stop stopColor="#ffffff" stopOpacity="0.32" />
          <stop offset="0.62" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="3" y="3" width="90" height="90" rx="27" fill="url(#update-brand-gradient)" />
      <rect x="3" y="3" width="90" height="90" rx="27" fill="url(#update-brand-glow)" />
      <circle cx="43" cy="41" r="21" fill="none" stroke="#ffffff" strokeWidth="6" />
      <path d="M58.5 56.5 73 71" fill="none" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" />
      <path d="m35.5 33.5 7.5 7.5-7.5 7.5M47.5 49h8.5" fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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

export function SettingsDialog({
  platform,
  initialSection,
  settings,
  appUpdateStatus,
  appUpdateBusy,
  appUpdateError,
  environments,
  environmentHealthReports,
  diagnosingEnvironmentId,
  theme,
  language,
  feedback,
  onSettingsChange,
  onCheckAppUpdate,
  onInstallAppUpdate,
  onSkipAppUpdate,
  onThemeChange,
  onLanguageChange,
  onDefaultTerminalChange,
  onGlobalShortcutChange,
  skillHookInstalled,
  skillHookBusy,
  onSkillHookChange,
  sessionHookStatus,
  sessionHookBusy,
  onSessionHookChange,
  onRefreshEnvironment,
  onDiagnoseEnvironment,
  onDeleteEnvironment,
  onAddSsh,
  onOpenApiConfig,
  onOpenRemoteSessions,
  onClose,
}: {
  platform: NodeJS.Platform;
  initialSection: SettingsSection;
  settings: AppSettings | null;
  appUpdateStatus: AppUpdateStatus | null;
  appUpdateBusy: boolean;
  appUpdateError: string | null;
  environments: SessionEnvironment[];
  environmentHealthReports: Record<string, RemoteHealthReport>;
  diagnosingEnvironmentId: string | null;
  theme: ThemeMode;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onCheckAppUpdate: () => void;
  onInstallAppUpdate: () => void;
  onSkipAppUpdate: (untilNextVersion: boolean) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onLanguageChange: (language: LanguageMode) => void;
  onDefaultTerminalChange: (terminal: AppSettings["defaultTerminal"]) => void;
  onGlobalShortcutChange: (shortcut: AppSettings["globalShortcut"]) => void;
  skillHookInstalled: boolean | null;
  skillHookBusy: boolean;
  onSkillHookChange: (enabled: boolean) => void;
  sessionHookStatus: SessionSyncHookStatus | null;
  sessionHookBusy: boolean;
  onSessionHookChange: (enabled: boolean) => void;
  onRefreshEnvironment: (environment: SessionEnvironment) => void;
  onDiagnoseEnvironment: (environment: SessionEnvironment) => void;
  onDeleteEnvironment: (environment: SessionEnvironment) => void;
  onAddSsh: () => void;
  onOpenApiConfig: () => void;
  onOpenRemoteSessions: () => void;
  onClose: () => void;
}): ReactElement {
  const defaultTerminal = settings?.defaultTerminal ?? (platform === "win32" ? "WindowsTerminal" : "Terminal");
  const globalShortcut = settings?.globalShortcut ?? (platform === "win32" ? "Ctrl+Alt+Space" : "Alt+Space");
  const saving = feedback?.kind === "running";
  const [summaryBatch, setSummaryBatch] = useState<{ running: boolean; message: string | null }>({ running: false, message: null });
  const [mcpEnabled, setMcpEnabled] = useState<boolean | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);

  useEffect(() => {
    void window.sessionSearch
      .getMcpStatus()
      .then(setMcpEnabled)
      .catch(() => setMcpEnabled(false));
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
    { label: l("Focus search", "聚焦搜索"), keyGroups: [[appShortcutModifier, "K"]] },
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
            <button className={activeSection === "remote" ? "active" : ""} onClick={() => setActiveSection("remote")}>
              <Cloud size={15} />
              <span>{l("Remote sync", "远程同步")}</span>
            </button>
            <button className={activeSection === "skills" ? "active" : ""} onClick={() => setActiveSection("skills")}>
              <PackageSearch size={15} />
              <span>{l("Skills", "Skills")}</span>
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
                    disabled={!settings || saving}
                    onChange={(event) => onDefaultTerminalChange(event.target.value as AppSettings["defaultTerminal"])}
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
                    disabled={!settings || saving}
                    onChange={(event) => onGlobalShortcutChange(event.target.value as AppSettings["globalShortcut"])}
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
                    <p>{l("Local and SSH environments indexed by session search.", "会话搜索索引的本地和 SSH 环境。")}</p>
                  </div>
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
                        <div className="connection-icon">{environment.kind === "local" ? <Laptop size={15} /> : <Server size={15} />}</div>
                        <div className="connection-main">
                          <span className="connection-title">{environment.label}</span>
                          <span className="connection-target">{environmentTarget(environment, language)}</span>
                          {environment.lastError ? <span className="connection-error">{environment.lastError}</span> : null}
                        </div>
                        <span className="connection-status">{environmentStatusLabel(environment, language)}</span>
                        {environment.kind === "ssh" ? (
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
                              <time>{formatRelativeTime(report.checkedAt)}</time>
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
                    <span className="settings-field-title">{l("Hide subagent sessions", "隐藏 Subagent 会话")}</span>
                    <span className="settings-field-sub">
                      {l(
                        "Exclude subagents from session lists, project counts, and statistics.",
                        "从会话列表、项目数量和统计中排除 Subagent。",
                      )}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.hideSubagentSessions)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ hideSubagentSessions: event.currentTarget.checked })}
                  />
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
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeCodeWizCli: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include ~/.claude-internal</span>
                    <span className="settings-field-sub">{l("Indexes Claude Code Internal sessions and allows migration to that CLI.", "索引 Claude Code Internal 会话，并允许迁移到该 CLI。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeClaudeInternal)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeClaudeInternal: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include ~/.codex-internal</span>
                    <span className="settings-field-sub">{l("Indexes Codex Internal sessions and allows migration to that CLI.", "索引 Codex Internal 会话，并允许迁移到该 CLI。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeCodexInternal)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeCodexInternal: event.currentTarget.checked })}
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
                    disabled={!settings || saving}
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
                    disabled={!settings || saving}
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
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeCodeBuddyCli: event.currentTarget.checked })}
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
                    disabled={!settings || saving}
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
                    disabled={!settings || saving}
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
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeOpenCode: event.currentTarget.checked })}
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
                    disabled={!settings || saving}
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
                    disabled={!settings || saving}
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
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeQoder: event.currentTarget.checked })}
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
                    disabled={!settings || saving}
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
                    disabled={!settings || saving}
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
                    disabled={!settings || saving}
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
                    disabled={!settings || saving}
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
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ compressionConcurrency: Number(event.currentTarget.value) })}
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
                      "Let Claude Code / Codex search your past sessions over MCP (search_sessions, get_session). Registers the server in their configs; restart them to apply.",
                      "让 Claude Code / Codex 通过 MCP 检索你的历史会话(search_sessions、get_session)。会注册到它们的配置中，重启后生效。",
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
              </section>
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
                    <button type="button" className="settings-action-button" onClick={onOpenRemoteSessions}>
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
                    disabled={!settings || saving}
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
                      <input
                        type="text"
                        value={settings.remoteSyncSupabaseUrl}
                        disabled={saving}
                        placeholder="https://your-project.supabase.co"
                        onChange={(event) => onSettingsChange({ remoteSyncSupabaseUrl: event.currentTarget.value })}
                      />
                    </label>
                    <label className="settings-field remote-sync-field">
                      <div className="settings-field-text">
                        <span className="settings-field-title">anon key</span>
                        <span className="settings-field-sub">{l("Stored locally. Do not commit this value to the repository.", "保存在本地，请不要提交到仓库。")}</span>
                      </div>
                      <input
                        type="password"
                        value={settings.remoteSyncSupabaseAnonKey}
                        disabled={saving}
                        placeholder="eyJhbGciOi..."
                        onChange={(event) => onSettingsChange({ remoteSyncSupabaseAnonKey: event.currentTarget.value })}
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
                        disabled={sessionHookBusy || saving || !settings.remoteSyncSupabaseUrl || !settings.remoteSyncSupabaseAnonKey}
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
                  <h3>{l("Skill usage", "Skill 统计")}</h3>
                  <p>{l("Count how often each skill is used so the Skills panel can sort by most used.", "统计每个 skill 的使用次数，让 Skills 面板可以按使用最多排序。")}</p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Track skill usage", "统计 Skill 使用次数")}</span>
                    <span className="settings-field-sub">
                      {l(
                        "Installs a PostToolUse hook in ~/.claude/settings.json for Claude Code. Codex usage is inferred automatically from local ~/.codex/sessions logs.",
                        "在 ~/.claude/settings.json 安装 Claude Code 的 PostToolUse hook。Codex 使用次数会自动从本地 ~/.codex/sessions 日志推断。",
                      )}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(skillHookInstalled)}
                    disabled={skillHookInstalled === null || skillHookBusy}
                    onChange={(event) => onSkillHookChange(event.currentTarget.checked)}
                  />
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
                  <input
                    type="text"
                    value={settings?.skillSyncSupabaseUrl ?? ""}
                    disabled={!settings || saving}
                    placeholder="https://your-project.supabase.co"
                    onChange={(event) => onSettingsChange({ skillSyncSupabaseUrl: event.currentTarget.value })}
                  />
                </label>
                <label className="settings-field skills-sync-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">anon key</span>
                    <span className="settings-field-sub">{l("Stored locally and used only for the skills sync table.", "保存在本地，仅用于 Skills 同步表。")}</span>
                  </div>
                  <input
                    type="password"
                    value={settings?.skillSyncSupabaseAnonKey ?? ""}
                    disabled={!settings || saving}
                    placeholder="eyJhbGciOi..."
                    onChange={(event) => onSettingsChange({ skillSyncSupabaseAnonKey: event.currentTarget.value })}
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
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ skillSyncEnabled: event.currentTarget.checked })}
                  />
                </label>
                <header className="settings-pane-head" style={{ marginTop: 18 }}>
                  <h3>{l("Rules sync", "Rules 同步")}</h3>
                  <p>
                    {l(
                      "Sync CLAUDE.md and .qoder/rules across devices using the same Supabase project as Skill sync.",
                      "使用与 Skill 同步相同的 Supabase 项目，跨设备同步 CLAUDE.md 和 .qoder/rules 规则文件。",
                    )}
                  </p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Enable rules sync", "启用 Rules 同步")}</span>
                    <span className="settings-field-sub">
                      {l("Uses the Supabase URL and anon key configured above for Skill sync.", "使用上方 Skill 同步配置的 Supabase URL 和 anon key。")}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.rulesSyncEnabled)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ rulesSyncEnabled: event.currentTarget.checked })}
                  />
                </label>
                <header className="settings-pane-head" style={{ marginTop: 18 }}>
                  <h3>{l("Memories sync", "Memories 同步")}</h3>
                  <p>
                    {l(
                      "Sync Qoder long-term memories across devices using the same Supabase project as Skill sync.",
                      "使用与 Skill 同步相同的 Supabase 项目，跨设备同步 Qoder 长期记忆。",
                    )}
                  </p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Enable memories sync", "启用 Memories 同步")}</span>
                    <span className="settings-field-sub">
                      {l("Uses the Supabase URL and anon key configured above for Skill sync.", "使用上方 Skill 同步配置的 Supabase URL 和 anon key。")}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.memoriesSyncEnabled)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ memoriesSyncEnabled: event.currentTarget.checked })}
                  />
                </label>
              </section>
            ) : null}
            {activeSection === "appearance" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>{l("Appearance", "外观")}</h3>
                  <p>{l("Choose the color theme and language used by the session search window.", "选择会话搜索窗口使用的颜色主题和语言。")}</p>
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
              </section>
            ) : null}
            {activeSection === "about" ? (
              <section className="settings-pane update-about-pane">
                <div className="update-app-identity">
                  <UpdateBrandMark />
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
                      disabled={!settings || saving}
                      onChange={(event) => onSettingsChange({ autoCheckUpdates: event.currentTarget.checked })}
                    />
                  </label>
                ) : null}
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

