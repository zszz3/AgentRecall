import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Webhook } from "lucide-react";

import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import { localize, type LanguageMode } from "../../language";

export function EvalSettings({
  language,
  settings,
  saving,
  onSettingsChange,
}: {
  language: LanguageMode;
  settings: AppSettings | null;
  saving: boolean;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const enabled = Boolean(settings?.evalEnabled);
  const [hookInstalled, setHookInstalled] = useState<boolean | null>(null);
  const [hookBusy, setHookBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshHookStatus = useCallback(async () => {
    setHookInstalled(await window.sessionSearch.getSkillUsageHookStatus());
  }, []);

  useEffect(() => {
    void refreshHookStatus().catch((cause) => setError(errorMessage(cause)));
  }, [refreshHookStatus, enabled]);

  const installHook = async (): Promise<void> => {
    setHookBusy(true);
    setError(null);
    try {
      await window.sessionSearch.installSkillUsageHook();
      await refreshHookStatus();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setHookBusy(false);
    }
  };

  return (
    <section className="settings-pane">
      <header className="settings-pane-head">
        <h3>{l("Eval", "Eval")}</h3>
        <p>{l(
          "Link skill triggers to your indexed sessions so you can review how installed skills are actually used.",
          "把 Skill 触发与已索引会话关联起来，回看已安装 Skill 的真实使用情况。",
        )}</p>
      </header>

      <label className="settings-field settings-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Enable Eval", "启用 Eval")}</span>
          <span className="settings-field-sub">{l(
            "Off by default. Analysis only reads data already indexed on this device.",
            "默认关闭。分析只读取本机已索引的数据。",
          )}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={enabled}
          disabled={!settings || saving}
          onChange={(event) => onSettingsChange({ evalEnabled: event.currentTarget.checked })}
        />
      </label>

      <div className="settings-field">
        <div className="settings-field-text">
          <span className="settings-field-title">
            <Webhook size={14} /> {l("Claude usage hook", "Claude 使用统计 Hook")}
          </span>
          <span className="settings-field-sub">
            {hookInstalled === null
              ? l("Checking hook status...", "正在检查 Hook 状态...")
              : hookInstalled
                ? l(
                  "Installed. New Claude skill triggers record which session they belong to.",
                  "已安装。新的 Claude Skill 触发会记录其所属会话。",
                )
                : l(
                  "Not installed. Without it, Claude skill triggers cannot be linked to sessions.",
                  "未安装。缺少它时，Claude 的 Skill 触发无法关联到会话。",
                )}
          </span>
        </div>
        {hookInstalled === false ? (
          <button type="button" disabled={!enabled || hookBusy} onClick={() => void installHook()}>
            {hookBusy ? l("Installing...", "安装中...") : l("Install hook", "安装 Hook")}
          </button>
        ) : null}
      </div>

      {error ? <p className="settings-error" role="alert">{error}</p> : null}
    </section>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
