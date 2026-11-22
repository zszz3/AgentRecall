import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import { localize, type LanguageMode } from "../../language";

export interface SummaryBatch {
  running: boolean;
  message: string | null;
  run: () => Promise<void>;
}

/**
 * Backfills missing session summaries. The Settings dialog holds this state instead of the AI section so a
 * running batch keeps its progress and its disabled Run button when the user switches sections and returns.
 */
export function useSummaryBatch(language: LanguageMode): SummaryBatch {
  const [summaryBatch, setSummaryBatch] = useState<{ running: boolean; message: string | null }>({ running: false, message: null });

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

  async function run(): Promise<void> {
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

  return { ...summaryBatch, run };
}

export function AiSummarySettings({
  language,
  settings,
  summaryBatch,
  onSettingsChange,
  onOpenApiConfig,
}: {
  language: LanguageMode;
  settings: AppSettings | null;
  summaryBatch: SummaryBatch;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onOpenApiConfig: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);

  return (
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
        <button className="settings-action-button" disabled={!settings || summaryBatch.running} onClick={() => void summaryBatch.run()}>
          {summaryBatch.running ? l("Summarizing...", "摘要中...") : l("Run", "运行")}
        </button>
      </div>
    </section>
  );
}
