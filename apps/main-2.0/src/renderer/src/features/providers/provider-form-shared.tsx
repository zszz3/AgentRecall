import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactElement, ReactNode, SetStateAction } from "react";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
import type { ApiConfig, ClaudeApiConfig } from "../../../../core/api-config";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";

export function normalizeProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function providerTargetMatches(
  config: Pick<ApiConfig | ClaudeApiConfig, "activeProvider" | "customProviderId" | "customBaseUrl"> | null | undefined,
  providerId: string,
  baseUrl: string,
): boolean {
  return config?.activeProvider === "custom"
    && config.customProviderId === providerId
    && normalizeProviderBaseUrl(config.customBaseUrl) === normalizeProviderBaseUrl(baseUrl);
}

/**
 * Status of a model probe or connection test against the draft fingerprinted by `signature`.
 * A result is dropped when a newer run has started or the draft changed while it was in flight,
 * and any draft edit clears the status, so it never describes a route the user has already left.
 */
export function useDraftCheck(signature: string): {
  status: SettingsFeedback;
  setStatus: Dispatch<SetStateAction<SettingsFeedback>>;
  run: <T>(runningMessage: string, request: () => Promise<T>, describeSuccess: (result: T) => string) => Promise<void>;
} {
  const [status, setStatus] = useState<SettingsFeedback>(null);
  const runIdRef = useRef(0);
  const signatureRef = useRef(signature);
  signatureRef.current = signature;

  useEffect(() => {
    runIdRef.current += 1;
    setStatus(null);
  }, [signature]);

  async function run<T>(runningMessage: string, request: () => Promise<T>, describeSuccess: (result: T) => string) {
    const runId = ++runIdRef.current;
    const startedSignature = signature;
    const isStale = () => runId !== runIdRef.current || startedSignature !== signatureRef.current;
    setStatus({ kind: "running", message: runningMessage });
    try {
      const result = await request();
      if (isStale()) return;
      setStatus({ kind: "success", message: describeSuccess(result) });
    } catch (error) {
      if (isStale()) return;
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { status, setStatus, run };
}

export function ProviderFormFrame({ language, saved, title, description, feedback, connection, actions, children }: {
  language: LanguageMode;
  saved?: boolean;
  title: string;
  description: string;
  feedback: SettingsFeedback;
  /** Connection test of a client route, whose result is reported next to the page feedback. */
  connection?: { target: "codex" | "claude"; status: SettingsFeedback; disabled: boolean; onTest: () => void };
  actions: ReactNode;
  children: ReactNode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <section className={`provider-page${saved ? " provider-editor-saved" : ""}`} data-page="provider-editor">
      <div className="api-config-body">
        <section className="settings-pane api-settings-form">
          <header className="settings-pane-head">
            <h3>{title}</h3>
            <p>{description}</p>
          </header>
          {children}
        </section>
      </div>
      <div className="dialog-actions api-config-actions">
        <div className="api-config-feedback" aria-live="polite">
          {feedback ? <span className={`api-config-status ${feedback.kind}`}>{feedback.message}</span> : null}
          {connection?.status ? (
            <span className={`api-config-status ${connection.status.kind}`}>{connection.status.message}</span>
          ) : null}
        </div>
        {connection ? (
          <button
            type="button"
            data-provider-connection-test={connection.target}
            disabled={connection.disabled || connection.status?.kind === "running"}
            onClick={connection.onTest}
          >
            {connection.status?.kind === "running"
              ? l("Testing connection...", "正在测试连接...")
              : l("Test connection", "测试连接")}
          </button>
        ) : null}
        {actions}
      </div>
    </section>
  );
}

/** Key box with a show/hide toggle; the toggle stays usable while the key itself is read-only. */
export function ApiKeyInput({ language, value, shown, disabled, editable = true, onToggle, onChange }: {
  language: LanguageMode;
  value: string;
  shown: boolean;
  disabled: boolean;
  editable?: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
}): ReactElement {
  const toggleLabel = shown
    ? localize(language, "Hide API key", "隐藏 API Key")
    : localize(language, "Show API key", "显示 API Key");
  return (
    <div className="secret-input">
      <input
        type={shown ? "text" : "password"}
        value={value}
        disabled={disabled || !editable}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button type="button" onClick={onToggle} disabled={disabled} aria-label={toggleLabel} title={toggleLabel}>
        {shown ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

export function DetectedModelCombo({ language, value, options, open, disabled, placeholder, onChange, onOpenChange }: {
  language: LanguageMode;
  value: string;
  options: string[];
  open: boolean;
  disabled: boolean;
  placeholder: string;
  onChange: (model: string) => void;
  onOpenChange: Dispatch<SetStateAction<boolean>>;
}): ReactElement {
  return (
    <div className="codex-model-combo">
      <input
        type="text"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-haspopup="listbox"
        aria-expanded={open}
        onFocus={() => onOpenChange(options.length > 0)}
        onBlur={() => window.setTimeout(() => onOpenChange(false), 100)}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          onOpenChange(options.length > 0);
        }}
      />
      <button
        type="button"
        className="codex-model-menu-trigger"
        disabled={disabled || options.length === 0}
        aria-label={localize(language, "Choose detected model", "选择探测到的模型")}
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onOpenChange((current) => !current)}
      >
        <ChevronDown size={14} />
      </button>
      {open && options.length > 0 ? (
        <div className="codex-model-menu" role="listbox">
          {options.map((model) => (
            <button
              type="button"
              className="codex-model-option"
              role="option"
              aria-selected={model === value}
              key={model}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(model);
                onOpenChange(false);
              }}
            >
              {model}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ConfigDirectoryInput({ language, value, placeholder, disabled, onChange, onBrowse }: {
  language: LanguageMode;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onBrowse: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="provider-path-input">
      <input
        type="text"
        title={value || placeholder}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button type="button" disabled={disabled} onClick={onBrowse}>{l("Browse", "选择")}</button>
      <button type="button" disabled={disabled || !value} onClick={() => onChange("")}>{l("Default", "默认")}</button>
    </div>
  );
}
