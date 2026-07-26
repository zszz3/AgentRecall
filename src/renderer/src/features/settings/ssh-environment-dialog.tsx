import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Plus, X } from "lucide-react";
import type { SshConfigHost } from "../../../../core/ssh-config";
import type {
  EnvironmentUpsertInput,
  SessionEnvironment,
  SshAuthMode,
} from "../../../../core/types";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";

export function existingSshHostAliases(
  environments: Array<Pick<SessionEnvironment, "kind" | "hostAlias" | "enabled">>,
): Set<string> {
  const aliases = new Set<string>();
  for (const environment of environments) {
    if (environment.kind !== "ssh" || !environment.enabled) continue;
    if (environment.hostAlias) aliases.add(environment.hostAlias);
  }
  return aliases;
}

export function disabledSshEnvironmentIdsByHostAlias(
  environments: Array<Pick<SessionEnvironment, "id" | "kind" | "hostAlias" | "enabled">>,
): Map<string, string> {
  const environmentIds = new Map<string, string>();
  for (const environment of environments) {
    if (environment.kind !== "ssh" || environment.enabled || !environment.hostAlias) continue;
    environmentIds.set(environment.hostAlias, environment.id);
  }
  return environmentIds;
}

export function SshEnvironmentDialog({
  environments,
  language,
  feedback,
  onSaveEnvironment,
  onClose,
}: {
  environments: SessionEnvironment[];
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSaveEnvironment: (input: EnvironmentUpsertInput) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [mode, setMode] = useState<"config" | "manual">("config");
  const [hosts, setHosts] = useState<SshConfigHost[]>([]);
  const [selectedAliases, setSelectedAliases] = useState<Set<string>>(() => new Set());
  const [loadingHosts, setLoadingHosts] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [manualLabel, setManualLabel] = useState("");
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState("");
  const [manualAuthMode, setManualAuthMode] = useState<SshAuthMode>("none");
  const [manualIdentityFile, setManualIdentityFile] = useState("");
  const saving = feedback?.kind === "running";
  const existingAliases = useMemo(() => existingSshHostAliases(environments), [environments]);
  const disabledEnvironmentIds = useMemo(
    () => disabledSshEnvironmentIdsByHostAlias(environments),
    [environments],
  );
  const selectableAliasCount = [...selectedAliases].filter((alias) => !existingAliases.has(alias)).length;

  useEffect(() => {
    let cancelled = false;
    setLoadingHosts(true);
    window.sessionSearch
      .listSshConfigHosts()
      .then((nextHosts) => {
        if (cancelled) return;
        setHosts(nextHosts);
        setSelectedAliases(new Set());
        setLocalError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setHosts([]);
        setLocalError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingHosts(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleAlias(alias: string): void {
    if (existingAliases.has(alias)) return;
    setSelectedAliases((current) => {
      const next = new Set(current);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  }

  async function addSelectedHosts(): Promise<void> {
    const selectedHosts = hosts.filter((host) => selectedAliases.has(host.alias) && !existingAliases.has(host.alias));
    if (selectedHosts.length === 0) {
      setLocalError(l("Select at least one SSH config host.", "至少选择一个 SSH 配置主机。"));
      return;
    }
    try {
      setLocalError(null);
      for (const host of selectedHosts) {
        await onSaveEnvironment({
          id: disabledEnvironmentIds.get(host.alias),
          kind: "ssh",
          label: host.alias,
          hostAlias: host.alias,
          host: host.hostName,
          user: host.user,
          port: host.port,
          authMode: host.identityFile ? "identityFile" : "none",
          identityFile: host.identityFile,
          enabled: true,
        });
      }
      onClose();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }

  async function addManualHost(): Promise<void> {
    try {
      const normalized = normalizeManualSshDraft({
        label: manualLabel,
        host: manualHost,
        port: manualPort,
        authMode: manualAuthMode,
        identityFile: manualIdentityFile,
      });
      setLocalError(null);
      await onSaveEnvironment({
        kind: "ssh",
        label: normalized.label,
        hostAlias: null,
        host: normalized.host,
        user: normalized.user,
        port: normalized.port,
        authMode: normalized.authMode,
        identityFile: normalized.identityFile,
        enabled: true,
      });
      onClose();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog ssh-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Add SSH", "添加 SSH")}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="ssh-dialog-body">
          {mode === "config" ? (
            <div className="ssh-config-panel">
              <div className="ssh-config-list">
                {loadingHosts ? <div className="ssh-empty">{l("Loading SSH config hosts...", "正在加载 SSH 配置主机...")}</div> : null}
                {!loadingHosts && hosts.length === 0 ? <div className="ssh-empty">{l("No SSH config hosts found.", "未找到 SSH 配置主机。")}</div> : null}
                {hosts.map((host) => {
                  const existing = existingAliases.has(host.alias);
                  const checked = existing || selectedAliases.has(host.alias);
                  return (
                    <label
                      key={host.alias}
                      className={`ssh-config-row ${checked ? "active" : ""} ${existing ? "disabled" : ""}`}
                      title={sshConfigHostDetail(host)}
                    >
                      <span className="ssh-host-main">
                        <strong>{host.alias}</strong>
                        <em>{sshConfigHostDetail(host)}</em>
                      </span>
                      <input
                        type="checkbox"
                        className="ssh-check"
                        checked={checked}
                        disabled={existing}
                        onChange={() => toggleAlias(host.alias)}
                        aria-label={
                          existing
                            ? l(`${host.alias} is already connected`, `${host.alias} 已连接`)
                            : l(`Select ${host.alias}`, `选择 ${host.alias}`)
                        }
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ) : (
            <form
              className="ssh-manual-form"
              onSubmit={(event) => {
                event.preventDefault();
                void addManualHost();
              }}
            >
              <label className="ssh-form-field">
                <span>{l("Display name", "显示名称")}</span>
                <input value={manualLabel} onChange={(event) => setManualLabel(event.target.value)} placeholder="devbox" />
              </label>
              <label className="ssh-form-field">
                <span>{l("Host", "主机")}</span>
                <input value={manualHost} onChange={(event) => setManualHost(event.target.value)} placeholder="user@host.com" autoFocus />
              </label>
              <label className="ssh-form-field">
                <span>{l("SSH port", "SSH 端口")}</span>
                <input value={manualPort} onChange={(event) => setManualPort(event.target.value)} placeholder="22" inputMode="numeric" />
              </label>
              <div className="ssh-form-field">
                <span>{l("Authentication", "认证")}</span>
                <div className="ssh-auth-toggle" role="group" aria-label={l("Authentication", "认证")}>
                  <button type="button" className={manualAuthMode === "none" ? "active" : ""} onClick={() => setManualAuthMode("none")}>
                    {l("No auth", "无认证")}
                  </button>
                  <button
                    type="button"
                    className={manualAuthMode === "identityFile" ? "active" : ""}
                    onClick={() => setManualAuthMode("identityFile")}
                  >
                    {l("Identity file", "身份文件")}
                  </button>
                </div>
              </div>
              {manualAuthMode === "identityFile" ? (
                <label className="ssh-form-field">
                  <span>{l("Identity file", "身份文件")}</span>
                  <input
                    value={manualIdentityFile}
                    onChange={(event) => setManualIdentityFile(event.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                  />
                </label>
              ) : null}
            </form>
          )}
        </div>
        <div className="ssh-dialog-footer">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setLocalError(null);
              setMode(mode === "config" ? "manual" : "config");
            }}
          >
            {mode === "config" ? l("Manual add", "手动添加") : l("SSH config", "SSH 配置")}
          </button>
          <div className={`settings-feedback inline ${localError ? "error" : feedback?.kind ?? ""}`} aria-live="polite">
            {localError ?? feedback?.message ?? ""}
          </div>
          <button
            type="button"
            className="primary"
            disabled={saving || (mode === "config" && selectableAliasCount === 0)}
            onClick={() => void (mode === "config" ? addSelectedHosts() : addManualHost())}
          >
            <Plus size={14} />
            <span>{l("Add", "添加")}</span>
          </button>
        </div>
      </section>
    </div>
  );
}

interface ManualSshDraft {
  label: string;
  host: string;
  port: string;
  authMode: SshAuthMode;
  identityFile: string;
}

function normalizeManualSshDraft(input: ManualSshDraft): {
  label: string;
  host: string;
  user: string | null;
  port: number | null;
  authMode: SshAuthMode;
  identityFile: string | null;
} {
  const rawHost = input.host.trim();
  if (!rawHost) throw new Error("SSH host is required.");
  const at = rawHost.lastIndexOf("@");
  const user = at >= 0 ? rawHost.slice(0, at).trim() || null : null;
  const host = at >= 0 ? rawHost.slice(at + 1).trim() : rawHost;
  if (!host) throw new Error("SSH host is required.");
  const port = parseManualSshPort(input.port.trim());
  return {
    label: input.label.trim() || host,
    host,
    user,
    port,
    authMode: input.authMode,
    identityFile: input.authMode === "identityFile" ? input.identityFile.trim() || null : null,
  };
}

function parseManualSshPort(value: string): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) throw new Error("SSH port must be a number from 1 to 65535.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("SSH port must be a number from 1 to 65535.");
  }
  return parsed;
}

function sshConfigHostDetail(host: SshConfigHost): string {
  const parts = [
    host.hostName ? `HostName ${host.hostName}` : null,
    host.user ? `User ${host.user}` : null,
    host.port ? `Port ${host.port}` : null,
    host.identityFile ? `IdentityFile ${host.identityFile}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ") || host.alias;
}
