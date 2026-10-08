import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import {
  Box,
  CircleStop,
  Cpu,
  Download,
  Play,
  RefreshCw,
} from "lucide-react";

import type {
  AppSettings,
  AppSettingsUpdate,
} from "../../../../core/platform";
import type {
  OpenVikingMemorySnapshot,
  OpenVikingRuntimeInstallPhase,
} from "../../../../core/openviking-memory";
import {
  MAX_OPENVIKING_RECALL_TOKEN_BUDGET,
  MIN_OPENVIKING_RECALL_TOKEN_BUDGET,
} from "../../../../core/openviking-settings";
import { localize, type LanguageMode } from "../../language";

type ComponentAction = "runtime" | "model" | "start" | "stop" | null;

export function OpenVikingMemorySettings({
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
  const enabled = Boolean(settings?.openVikingMemoryEnabled);
  const [snapshot, setSnapshot] = useState<OpenVikingMemorySnapshot | null>(null);
  const [action, setAction] = useState<ComponentAction>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSnapshot(await window.sessionSearch.getOpenVikingMemorySnapshot());
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setError(errorMessage(cause)));
  }, [refresh]);

  useEffect(() => {
    if (
      action !== "runtime"
      && action !== "start"
      && action !== "model"
      && !snapshot?.model.downloading
      && snapshot?.runtime.state !== "installing"
      && snapshot?.runtime.state !== "starting"
    ) return;
    const timer = window.setInterval(() => {
      void refresh().catch((cause) => setError(errorMessage(cause)));
    }, 500);
    return () => window.clearInterval(timer);
  }, [action, refresh, snapshot?.runtime.state, snapshot?.model.downloading]);

  const run = async (nextAction: Exclude<ComponentAction, null>, operation: () => Promise<unknown>) => {
    setAction(nextAction);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const runtimeState = snapshot?.runtime.state ?? "not-installed";
  const runtimeProgress = snapshot?.runtime.progress;
  const runtimePercent = runtimeProgress?.totalBytes
    ? Math.min(100, Math.round(
      ((runtimeProgress.downloadedBytes ?? 0) / runtimeProgress.totalBytes) * 100,
    ))
    : null;
  const runtimeDownloadedMb = runtimeProgress?.downloadedBytes === undefined
    ? null
    : (runtimeProgress.downloadedBytes / 1_000_000).toFixed(1);
  const runtimeProgressSize = runtimeDownloadedMb === null
    ? null
    : runtimeProgress?.totalBytes
      ? `${runtimeDownloadedMb} / ${(runtimeProgress.totalBytes / 1_000_000).toFixed(1)} MB`
      : runtimeProgress?.phase === "packaging-runtime"
        ? l(`Generated ${runtimeDownloadedMb} MB`, `已生成 ${runtimeDownloadedMb} MB`)
        : `${runtimeDownloadedMb} MB`;
  const runtimeDownloadSpeed = runtimeProgress?.bytesPerSecond
    ? `${(runtimeProgress.bytesPerSecond / 1_000_000).toFixed(1)} MB/s`
    : null;
  const runtimeInstalledSize = snapshot?.runtime.installedBytes === undefined
    ? null
    : (snapshot.runtime.installedBytes / 1_000_000).toFixed(1);
  const modelInstalled = Boolean(snapshot?.model.installed);
  const modelProgress = snapshot?.model;
  const modelPercent = modelProgress?.totalBytes && modelProgress.downloadedBytes !== undefined
    ? Math.min(100, Math.round(modelProgress.downloadedBytes / modelProgress.totalBytes * 100))
    : null;
  const controlsDisabled = !enabled || saving || action !== null || Boolean(modelProgress?.downloading);
  return (
    <section className="settings-pane openviking-settings-pane">
      <header className="settings-pane-head">
        <h3>{l("Directory memory", "目录记忆")}</h3>
        <p>{l(
          "Track future agent turns in selected directories and build isolated long-term memory with a locally managed OpenViking service.",
          "使用本机托管的 OpenViking，增量跟踪选定目录中未来产生的 Agent 对话，并建立彼此隔离的长期记忆。",
        )}</p>
      </header>

      <label className="settings-field settings-toggle openviking-master-toggle">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Enable directory memory", "启用目录记忆")}</span>
          <span className="settings-field-sub">{l(
            "Off by default. Historical sessions are not bulk-imported; use AgentRecall search and save only the context you choose to reuse.",
            "默认关闭。历史会话不会批量导入；可通过 AgentRecall 搜索定位，并只保存你确认需要复用的内容。",
          )}</span>
        </div>
        <input
          type="checkbox"
          className="switch"
          checked={enabled}
          disabled={!settings || saving}
          onChange={(event) => onSettingsChange({ openVikingMemoryEnabled: event.currentTarget.checked })}
        />
      </label>

      <div className="openviking-component-list">
        <div className="openviking-component-card">
          <span className="openviking-component-icon"><Box size={18} /></span>
          <div>
            <strong>OpenViking {snapshot?.runtime.version ?? "0.4.11-r6"}</strong>
            <span>{runtimeInstalledSize
              ? `${runtimeInstalledSize} / ${runtimeInstalledSize} MB`
              : l(
                "About 260–320 MB download",
                "下载约 260–320 MB",
              )}</span>
            {runtimeState === "installing" ? (
              <div className="openviking-runtime-progress">
                <div className="openviking-runtime-progress-meta">
                  <span>{runtimeLabel(runtimeState, language, runtimeProgress?.phase)}</span>
                  <span>
                    {runtimeProgressSize}
                    {runtimePercent === null ? null : ` · ${runtimePercent}%`}
                    {runtimeDownloadSpeed ? ` · ${runtimeDownloadSpeed}` : null}
                  </span>
                </div>
                <div className="openviking-runtime-progress-track" aria-hidden="true">
                  <span
                    className={runtimePercent === null
                      ? "openviking-runtime-progress-fill indeterminate"
                      : "openviking-runtime-progress-fill"}
                    style={runtimePercent === null ? undefined : { width: `${runtimePercent}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>
          <span className={`openviking-status ${runtimeState}`}>
            {runtimeLabel(runtimeState, language, runtimeProgress?.phase)}
          </span>
          {runtimeState === "not-installed" ? (
            <button
              type="button"
              className="settings-action-button"
              disabled={controlsDisabled}
              onClick={() => void run("runtime", () => window.sessionSearch.installOpenVikingRuntime())}
            >
              {action === "runtime" ? <RefreshCw size={14} className="spin" /> : <Download size={14} />}
              {l("Download", "下载")}
            </button>
          ) : runtimeState === "running" ? (
            <button
              type="button"
              className="settings-action-button"
              disabled={controlsDisabled}
              onClick={() => void run("stop", () => window.sessionSearch.stopOpenVikingRuntime())}
            >
              {action === "stop" ? <RefreshCw size={14} className="spin" /> : <CircleStop size={14} />}
              {l("Stop", "停止")}
            </button>
          ) : (
            <button
              type="button"
              className="settings-action-button"
              disabled={controlsDisabled || !modelInstalled}
              onClick={() => void run("start", () => window.sessionSearch.startOpenVikingRuntime())}
            >
              {action === "start" ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
              {l("Start", "启动")}
            </button>
          )}
        </div>

        <div className="openviking-component-card">
          <span className="openviking-component-icon"><Cpu size={18} /></span>
          <div>
            <strong>BAAI/bge-small-zh-v1.5</strong>
            <span>{l(
              "Local embedding · 47.9 MB · CPU is enough, no dedicated GPU required",
              "本地向量模型 · 47.9 MB · CPU 即可运行，不要求独立显卡",
            )}</span>
            {modelProgress?.downloading ? (
              <div className="openviking-runtime-progress" role="status">
                <div className="openviking-runtime-progress-meta">
                  <span>{l("Downloading model", "下载向量模型")}</span>
                  <span>
                    {((modelProgress.downloadedBytes ?? 0) / 1_000_000).toFixed(1)}
                    {modelProgress.totalBytes ? ` / ${(modelProgress.totalBytes / 1_000_000).toFixed(1)}` : ""} MB
                    {modelPercent === null ? null : ` · ${modelPercent}%`}
                  </span>
                </div>
                <div className="openviking-runtime-progress-track" aria-hidden="true">
                  <span
                    className={modelPercent === null ? "openviking-runtime-progress-fill indeterminate" : "openviking-runtime-progress-fill"}
                    style={modelPercent === null ? undefined : { width: `${modelPercent}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>
          <span className={`openviking-status ${modelInstalled ? "running" : "not-installed"}`}>
            {modelInstalled ? l("Downloaded", "已下载") : l("Not downloaded", "未下载")}
          </span>
          {!modelInstalled ? (
            <button
              type="button"
              className="settings-action-button"
              disabled={controlsDisabled}
              onClick={() => void run(
                "model",
                () => window.sessionSearch.installOpenVikingModel("BAAI/bge-small-zh-v1.5"),
              )}
            >
              {action === "model" ? <RefreshCw size={14} className="spin" /> : <Download size={14} />}
              {l("Download 47.9 MB", "下载 47.9 MB")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="openviking-integration-settings">
        <div className="settings-pane-head compact">
          <h3>{l("Automatic recall and capture", "自动召回与记忆")}</h3>
          <p>{l(
            "Only events inside managed directories are forwarded. Hook failures never block the agent.",
            "只有受管理目录内的事件会被处理；Hook 失败不会阻断 agent。",
          )}</p>
        </div>
        <label className="settings-field openviking-recall-budget-field">
          <div className="settings-field-text">
            <span className="settings-field-title">{l("Automatic recall budget", "自动召回预算")}</span>
            <span className="settings-field-sub">{l(
              "Limits injected memory by estimated model Tokens instead of characters.",
              "按照模型 Token 估算限制自动注入，不再使用字符数预算。",
            )}</span>
          </div>
          <input
            type="number"
            className="settings-number"
            min={MIN_OPENVIKING_RECALL_TOKEN_BUDGET}
            max={MAX_OPENVIKING_RECALL_TOKEN_BUDGET}
            step={128}
            value={settings?.openVikingRecallTokenBudget ?? 1_200}
            disabled={!enabled || !settings || saving}
            onChange={(event) => onSettingsChange({
              openVikingRecallTokenBudget: Number(event.currentTarget.value),
            })}
          />
        </label>
        <IntegrationToggle
          label="Claude Code"
          checked={Boolean(settings?.openVikingClaudeEnabled)}
          disabled={!enabled || !settings || saving}
          onChange={(checked) => onSettingsChange({ openVikingClaudeEnabled: checked })}
        />
        <IntegrationToggle
          label="Codex"
          checked={Boolean(settings?.openVikingCodexEnabled)}
          disabled={!enabled || !settings || saving}
          onChange={(checked) => onSettingsChange({ openVikingCodexEnabled: checked })}
        />
        <IntegrationToggle
          label="OpenCode"
          checked={Boolean(settings?.openVikingOpenCodeEnabled)}
          disabled={!enabled || !settings || saving}
          onChange={(checked) => onSettingsChange({ openVikingOpenCodeEnabled: checked })}
        />
      </div>

      {error ? <div className="openviking-settings-error">{error}</div> : null}
    </section>
  );
}

function IntegrationToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <label className="settings-field settings-toggle openviking-integration-toggle">
      <div className="settings-field-text">
        <span className="settings-field-title">{label}</span>
      </div>
      <input
        type="checkbox"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function runtimeLabel(
  state: OpenVikingMemorySnapshot["runtime"]["state"],
  language: LanguageMode,
  phase?: OpenVikingRuntimeInstallPhase,
): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  switch (phase) {
    case "resolving-runtime": return l("Checking download", "检查下载");
    case "downloading-python": return l("Downloading runtime base", "下载运行环境");
    case "building-runtime": return l("Installing OpenViking", "安装 OpenViking");
    case "packaging-runtime": return l("Packaging runtime", "打包运行时");
    case "downloading-runtime": return l("Downloading runtime", "下载运行时");
    case "verifying-runtime": return l("Verifying download", "校验下载");
    case "installing-runtime": return l("Installing runtime", "安装运行时");
  }
  switch (state) {
    case "running": return l("Service running", "服务运行中");
    case "stopped": return l("Service stopped", "服务已停止");
    case "installing": return l("Downloading", "下载中");
    case "starting": return l("Starting service", "正在启动服务");
    case "error": return l("Error", "异常");
    default: return l("Not downloaded", "未下载");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
