import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import type { EnvironmentUpsertInput, SessionEnvironment } from "../../../../core/types";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";

export function WslEnvironmentDialog({
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
  const [distributions, setDistributions] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const saving = feedback?.kind === "running";
  const existing = useMemo(
    () => new Set(environments.filter((environment) => environment.kind === "wsl").map((environment) => environment.wslDistribution).filter(Boolean)),
    [environments],
  );
  const available = distributions.filter((distribution) => !existing.has(distribution));

  async function loadDistributions(manual = false): Promise<void> {
    if (manual) setRefreshing(true);
    else setLoading(true);
    try {
      const next = await window.sessionSearch.listWslDistributions();
      setDistributions(next);
      setSelected((current) => (current && next.includes(current) ? current : next.find((item) => !existing.has(item)) ?? next[0] ?? ""));
      setLocalError(null);
    } catch (error) {
      setDistributions([]);
      setSelected("");
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadDistributions();
  }, []);

  async function addDistribution(): Promise<void> {
    const distribution = selected.trim();
    if (!distribution) {
      setLocalError(l("Select a WSL distribution.", "请选择一个 WSL 发行版。"));
      return;
    }
    try {
      setLocalError(null);
      await onSaveEnvironment({
        kind: "wsl",
        label: distribution,
        wslDistribution: distribution,
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
          <span>{l("Add WSL", "添加 WSL")}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="ssh-dialog-body">
          <div className="ssh-config-panel">
            <div className="ssh-config-list">
              {loading ? <div className="ssh-empty">{l("Loading WSL distributions...", "正在加载 WSL 发行版...")}</div> : null}
              {!loading && distributions.length === 0 ? <div className="ssh-empty">{l("No WSL distributions found.", "未找到 WSL 发行版。")}</div> : null}
              {available.map((distribution) => (
                <label key={distribution} className={`ssh-config-row ${selected === distribution ? "active" : ""}`}>
                  <span className="ssh-host-main">
                    <strong>{distribution}</strong>
                    <em>{l("Local Linux", "本地 Linux")}</em>
                  </span>
                  <input
                    type="radio"
                    name="wsl-distribution"
                    className="ssh-check"
                    checked={selected === distribution}
                    onChange={() => setSelected(distribution)}
                    aria-label={l(`Select ${distribution}`, `选择 ${distribution}`)}
                  />
                </label>
              ))}
              {!loading && distributions.length > 0 && available.length === 0 ? (
                <div className="ssh-empty">{l("All WSL distributions are already connected.", "所有 WSL 发行版都已连接。")}</div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="ssh-dialog-footer">
          <button type="button" className="secondary" disabled={refreshing || saving} onClick={() => void loadDistributions(true)}>
            <RefreshCw size={14} /> {l("Refresh", "刷新")}
          </button>
          <div className={`settings-feedback inline ${localError ? "error" : feedback?.kind ?? ""}`} aria-live="polite">
            {localError ?? feedback?.message ?? ""}
          </div>
          <button type="button" className="primary" disabled={saving || loading || !selected || available.length === 0} onClick={() => void addDistribution()}>
            <Plus size={14} /> <span>{l("Add", "添加")}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
