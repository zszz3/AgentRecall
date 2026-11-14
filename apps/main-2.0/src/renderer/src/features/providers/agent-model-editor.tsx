import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Eye, EyeOff } from "lucide-react";

import {
  AGENT_MODEL_APIS,
  AGENT_MODEL_CUSTOM_PROVIDER,
  agentModelConfigured,
  type AgentModelApi,
  type AgentModelConfig,
  type AgentModelProviderOption,
} from "../../../../core/agent-model-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";

const API_LABELS: Record<AgentModelApi, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

/**
 * Chooses the model and API key AgentRecall uses for experience cards and AI Skill exploration.
 * The settings write reports through the shared settings feedback; key storage and tests report here.
 */
export function AgentModelEditor({ settings, language, feedback, onSettingsChange }: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (update: AppSettingsUpdate) => void | Promise<void>;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [providers, setProviders] = useState<AgentModelProviderOption[] | null>(null);
  const [draft, setDraft] = useState<AgentModelConfig | null>(settings?.agentModel ?? null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [running, setRunning] = useState<"test" | "save" | null>(null);
  const runningRef = useRef(false);
  const [notice, setNotice] = useState<SettingsFeedback>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    window.sessionSearch.listAgentModelProviders().then((items) => {
      if (alive.current) setProviders(items);
    }).catch((error: unknown) => {
      if (alive.current) setNotice({ kind: "error", message: readableError(error) });
    });
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!draft && settings) setDraft(settings.agentModel);
  }, [draft, settings]);

  const providerId = draft?.provider ?? "";
  useEffect(() => {
    setHasKey(false);
    if (!providerId) return;
    let cancelled = false;
    window.sessionSearch.hasAgentModelKey(providerId).then((saved) => {
      if (!cancelled) setHasKey(saved);
    }).catch((error: unknown) => {
      if (!cancelled) setNotice({ kind: "error", message: readableError(error) });
    });
    return () => { cancelled = true; };
  }, [providerId]);

  const custom = providerId === AGENT_MODEL_CUSTOM_PROVIDER;
  const provider = providers?.find((item) => item.id === providerId);
  const models = provider?.models ?? [];

  function chooseProvider(id: string) {
    setDraft((current) => current && {
      ...current,
      provider: id,
      model: id === AGENT_MODEL_CUSTOM_PROVIDER ? "" : providers?.find((item) => item.id === id)?.models[0]?.id ?? "",
    });
    setApiKey("");
    setNotice(null);
  }

  function update(change: Partial<AgentModelConfig>) {
    setDraft((current) => current && { ...current, ...change });
    setNotice(null);
  }

  async function run(kind: "test" | "save", operation: (config: AgentModelConfig, key: string) => Promise<SettingsFeedback>) {
    if (!draft || runningRef.current) return;
    if (!agentModelConfigured(draft)) {
      setNotice({ kind: "error", message: custom
        ? l("Enter the endpoint URL and model ID first.", "请先填写接口地址和模型 ID。")
        : l("Choose a provider and model first.", "请先选择服务商和模型。") });
      return;
    }
    if (!custom && !apiKey.trim() && !hasKey) {
      setNotice({ kind: "error", message: l("Enter the API key for this provider.", "请填写这个服务商的 API Key。") });
      return;
    }
    runningRef.current = true;
    setRunning(kind);
    setNotice({ kind: "running", message: kind === "test" ? l("Testing the model…", "正在测试模型…") : l("Saving…", "正在保存…") });
    try {
      const result = await operation(draft, apiKey.trim());
      if (alive.current) setNotice(result);
    } catch (error) {
      if (alive.current) setNotice({ kind: "error", message: readableError(error) });
    } finally {
      runningRef.current = false;
      if (alive.current) setRunning(null);
    }
  }

  const test = () => run("test", async (config, key) => {
    const result = await window.sessionSearch.testAgentModel(config, key || null);
    return { kind: "success", message: l(`Connected. ${result.model} replied: ${clip(result.reply)}`, `连接成功，${result.model} 回复：${clip(result.reply)}`) };
  });

  const save = () => run("save", async (config, key) => {
    if (key) {
      await window.sessionSearch.saveAgentModelKey(config.provider, key);
      if (alive.current) {
        setApiKey("");
        setHasKey(true);
      }
    }
    await onSettingsChange({ agentModel: config });
    return null;
  });

  const disabled = !draft || running !== null;
  const status = notice ?? feedback;
  const keyHint = hasKey
    ? l("Saved. Leave empty to keep using the saved key.", "已保存。留空则继续使用已保存的 Key。")
    : custom
      ? l("Leave empty if the endpoint needs no key.", "接口不需要 Key 时可以留空。")
      : provider?.keyLabel ?? "";

  return (
    <>
      <div className="api-config-body">
        <section className="settings-pane api-settings-form" data-page="agent-model">
          <header className="settings-pane-head">
            <h3>{l("AgentRecall model", "AgentRecall 模型")}</h3>
            <p>{l(
              "Experience cards and AI Skill exploration send their prompts straight to this model. The calls use its API quota and do not create agent sessions.",
              "经验卡和 AI Skill 探索直接把请求发给这个模型，会消耗它的 API 用量，不会产生 Agent 会话。",
            )}</p>
          </header>
          <label className="settings-field">
            <div className="settings-field-text"><span className="settings-field-title">{l("Provider", "服务商")}</span></div>
            <select value={providerId} disabled={disabled || !providers} onChange={(event) => chooseProvider(event.currentTarget.value)}>
              <option value="">{providers ? l("Choose a provider…", "选择服务商…") : l("Loading providers…", "正在读取服务商…")}</option>
              {providerId && providers && !provider && !custom ? <option value={providerId}>{providerId}</option> : null}
              {(providers ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              <option value={AGENT_MODEL_CUSTOM_PROVIDER}>{l("Custom endpoint", "自定义接口")}</option>
            </select>
          </label>
          {custom ? <>
            <label className="settings-field">
              <div className="settings-field-text"><span className="settings-field-title">{l("Endpoint URL", "接口地址")}</span></div>
              <input value={draft?.baseUrl ?? ""} disabled={disabled} placeholder="https://api.example.com/v1" onChange={(event) => update({ baseUrl: event.currentTarget.value })} />
            </label>
            <label className="settings-field">
              <div className="settings-field-text"><span className="settings-field-title">{l("API format", "接口格式")}</span></div>
              <select value={draft?.api ?? AGENT_MODEL_APIS[0]} disabled={disabled} onChange={(event) => update({ api: event.currentTarget.value as AgentModelApi })}>
                {AGENT_MODEL_APIS.map((api) => <option key={api} value={api}>{API_LABELS[api]}</option>)}
              </select>
            </label>
          </> : null}
          {providerId ? <label className="settings-field">
            <div className="settings-field-text"><span className="settings-field-title">{l("Model", "模型")}</span></div>
            {custom
              ? <input value={draft?.model ?? ""} disabled={disabled} placeholder={l("Model ID", "模型 ID")} onChange={(event) => update({ model: event.currentTarget.value })} />
              : <select value={draft?.model ?? ""} disabled={disabled} onChange={(event) => update({ model: event.currentTarget.value })}>
                {draft?.model && !models.some((model) => model.id === draft.model) ? <option value={draft.model}>{draft.model}</option> : null}
                {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>}
          </label> : null}
          {providerId ? <label className="settings-field">
            <div className="settings-field-text">
              <span className="settings-field-title">API Key</span>
              <span className="settings-field-sub">{keyHint}</span>
            </div>
            <div className="secret-input">
              <input type={showKey ? "text" : "password"} value={apiKey} disabled={disabled} autoComplete="off" onChange={(event) => setApiKey(event.currentTarget.value)} />
              <button
                type="button"
                disabled={disabled}
                onClick={() => setShowKey((current) => !current)}
                aria-label={showKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                title={showKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </label> : null}
        </section>
      </div>
      <div className="dialog-actions api-config-actions">
        <div className="api-config-feedback" aria-live="polite">
          {status ? <span className={`api-config-status ${status.kind}`}>{status.message}</span> : null}
        </div>
        <button type="button" disabled={disabled || !providerId} onClick={() => void test()}>
          {running === "test" ? l("Testing…", "正在测试…") : l("Test", "测试")}
        </button>
        <button type="button" className="primary-action" disabled={disabled || !providerId} onClick={() => void save()}>
          {l("Save", "保存")}
        </button>
      </div>
    </>
  );
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** Electron prefixes errors from the main process with the IPC channel; users only need the reason. */
function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}
