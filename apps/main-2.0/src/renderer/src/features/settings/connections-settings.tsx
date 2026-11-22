import type { ReactElement } from "react";
import { Activity, Container, Laptop, Plus, RefreshCw, Server, Trash2 } from "lucide-react";

import { formatRelativeTime } from "../../../../core/format-session";
import type { RemoteHealthReport } from "../../../../core/remote-health";
import type { SessionEnvironment } from "../../../../core/types";
import { localize, type LanguageMode } from "../../language";
import {
  environmentStatus,
  environmentStatusLabel,
  environmentTarget,
} from "../environments/environment-display";

export function ConnectionsSettings({
  language,
  platform,
  environments,
  environmentHealthReports,
  diagnosingEnvironmentId,
  onAddSsh,
  onAddWsl,
  onRefreshEnvironment,
  onDiagnoseEnvironment,
  onDeleteEnvironment,
}: {
  language: LanguageMode;
  platform: NodeJS.Platform;
  environments: SessionEnvironment[];
  environmentHealthReports: Record<string, RemoteHealthReport>;
  diagnosingEnvironmentId: string | null;
  onAddSsh: () => void;
  onAddWsl?: () => void;
  onRefreshEnvironment: (environment: SessionEnvironment) => void;
  onDiagnoseEnvironment: (environment: SessionEnvironment) => void;
  onDeleteEnvironment: (environment: SessionEnvironment) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);

  return (
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
                          {check.suggestion ? <small style={{ display: "block" }}>{check.suggestion}</small> : null}
                          {check.repairCommand ? <code style={{ display: "block", userSelect: "text" }}>{check.repairCommand}</code> : null}
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
  );
}
