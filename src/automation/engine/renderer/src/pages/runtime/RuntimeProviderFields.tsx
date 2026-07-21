import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AgentChannel, RuntimeProviderApiFormat } from "../../../../shared/types";
import { agentAccent, agentLabel } from "../../app/agents";
import type { Language } from "../../app/language";
import { headersToText, withOptionalHeaders, withOptionalString } from "./runtime-utils";

interface RuntimeProviderFieldsProps {
  channel: AgentChannel;
  language: Language;
  onChange: (updater: (channel: AgentChannel) => AgentChannel) => void;
}

const CLAUDE_MODEL_FIELDS = [
  ["ANTHROPIC_DEFAULT_SONNET_MODEL", "Sonnet"],
  ["ANTHROPIC_DEFAULT_OPUS_MODEL", "Opus"],
  ["ANTHROPIC_DEFAULT_FABLE_MODEL", "Fable"],
  ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "Haiku"],
  ["CLAUDE_CODE_SUBAGENT_MODEL", "Subagent"],
] as const;

function objectToJson(value: Record<string, unknown> | undefined): string {
  return value ? JSON.stringify(value, null, 2) : "";
}

function environmentToText(value: Record<string, string> | undefined): string {
  return value ? Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n") : "";
}

function textToEnvironment(value: string): Record<string, string> | undefined {
  const entries = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator > 0 ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] : null;
    })
    .filter((entry): entry is [string, string] => Boolean(entry?.[0]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function updateEnvironment(channel: AgentChannel, key: string, value: string): AgentChannel {
  const environment = { ...(channel.environment ?? {}) };
  const trimmed = value.trim();
  if (trimmed) environment[key] = trimmed;
  else delete environment[key];
  const next = { ...channel, models: channel.models.map((model) => ({ ...model })) };
  if (Object.keys(environment).length > 0) next.environment = environment;
  else delete next.environment;
  return next;
}

export function RuntimeProviderFields({ channel, language, onChange }: RuntimeProviderFieldsProps) {
  const zh = language === "zh";
  const [overrideHeaders, setOverrideHeaders] = useState(objectToJson(channel.requestOverrides?.headers));
  const [overrideBody, setOverrideBody] = useState(objectToJson(channel.requestOverrides?.body));
  const [environmentText, setEnvironmentText] = useState(environmentToText(channel.environment));
  const [providerHeadersText, setProviderHeadersText] = useState(headersToText(channel.httpHeaders));
  const [overrideError, setOverrideError] = useState("");
  const [showSensitiveValues, setShowSensitiveValues] = useState(false);

  useEffect(() => {
    setOverrideHeaders(objectToJson(channel.requestOverrides?.headers));
    setOverrideBody(objectToJson(channel.requestOverrides?.body));
    setEnvironmentText(environmentToText(channel.environment));
    setProviderHeadersText(headersToText(channel.httpHeaders));
    setOverrideError("");
  }, [channel.id]);

  const commitRequestOverrides = (headersText: string, bodyText: string) => {
    try {
      const headers = headersText.trim() ? JSON.parse(headersText) as Record<string, string> : undefined;
      const body = bodyText.trim() ? JSON.parse(bodyText) as Record<string, unknown> : undefined;
      if (headers && (Array.isArray(headers) || Object.values(headers).some((value) => typeof value !== "string"))) {
        throw new Error(zh ? "请求头必须是字符串键值对象" : "Headers must be a string map");
      }
      if (body && (Array.isArray(body) || typeof body !== "object")) {
        throw new Error(zh ? "请求体必须是 JSON 对象" : "Body must be a JSON object");
      }
      setOverrideError("");
      onChange((current) => {
        const next = { ...current };
        if (headers || body) next.requestOverrides = { ...(headers ? { headers } : {}), ...(body ? { body } : {}) };
        else delete next.requestOverrides;
        return next;
      });
    } catch (error) {
      setOverrideError(error instanceof Error ? error.message : String(error));
    }
  };

  const updateApiFormat = (value: string) => {
    onChange((current) => {
      const next = { ...current };
      if (value) next.apiFormat = value as RuntimeProviderApiFormat;
      else delete next.apiFormat;
      return next;
    });
  };

  return (
    <div className="config-field-grid">
      <div className="config-field config-field-wide runtime-secret-visibility">
        <button
          type="button"
          className="control-btn compact secondary"
          aria-label={showSensitiveValues ? "Hide advanced secrets" : "Show advanced secrets"}
          onClick={() => setShowSensitiveValues((visible) => !visible)}
        >
          {showSensitiveValues ? <EyeOff size={13} /> : <Eye size={13} />}
          <span>{showSensitiveValues ? (zh ? "隐藏敏感值" : "Hide sensitive values") : (zh ? "显示敏感值" : "Show sensitive values")}</span>
        </button>
      </div>
      <label className="config-field">
        <span>{zh ? "渠道 ID" : "Channel ID"}</span>
        <div className="configured-agent-runtime-readonly">
          <span className={`agent-badge mini ${agentAccent(channel.agentId)}`}>{agentLabel(channel.agentId)}</span>
          <strong>{channel.id}</strong>
        </div>
      </label>
      <label className="config-field">
        <span>{zh ? "名称" : "Label"}</span>
        <input value={channel.label} onChange={(event) => onChange((current) => ({ ...current, label: event.currentTarget.value }))} />
      </label>
      <label className="config-field">
        <span>Model Provider</span>
        <input value={channel.modelProvider ?? ""} onChange={(event) => onChange((current) => withOptionalString(current, "modelProvider", event.currentTarget.value))} />
      </label>
      <label className="config-field">
        <span>{zh ? "供应商名称" : "Provider Name"}</span>
        <input value={channel.providerName ?? ""} onChange={(event) => onChange((current) => withOptionalString(current, "providerName", event.currentTarget.value))} />
      </label>
      <label className="config-field config-field-wide">
        <span>Base URL</span>
        <input value={channel.baseUrl ?? ""} onChange={(event) => onChange((current) => withOptionalString(current, "baseUrl", event.currentTarget.value))} />
      </label>
      <label className="config-field config-inline-toggle">
        <input
          type="checkbox"
          checked={channel.isFullUrl === true}
          onChange={(event) => onChange((current) => ({ ...current, isFullUrl: event.currentTarget.checked }))}
        />
        <span>{zh ? "Base URL 是完整接口地址" : "Base URL is a full endpoint"}</span>
      </label>

      {channel.agentId === "claude" ? (
        <>
          <label className="config-field">
            <span>{zh ? "上游 API 格式" : "Upstream API format"}</span>
            <select value={channel.apiFormat ?? "anthropic"} onChange={(event) => updateApiFormat(event.currentTarget.value)}>
              <option value="anthropic">Anthropic Messages</option>
              <option value="openai_chat">OpenAI Chat Completions</option>
              <option value="openai_responses">OpenAI Responses</option>
              <option value="gemini_native">Gemini Native</option>
            </select>
          </label>
          <label className="config-field">
            <span>{zh ? "鉴权环境变量" : "API key environment"}</span>
            <select
              value={channel.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN"}
              onChange={(event) => onChange((current) => ({
                ...current,
                apiKeyField: event.currentTarget.value as "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY",
              }))}
            >
              <option value="ANTHROPIC_AUTH_TOKEN">ANTHROPIC_AUTH_TOKEN</option>
              <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY</option>
            </select>
          </label>
          {CLAUDE_MODEL_FIELDS.map(([key, label]) => (
            <label className="config-field" key={key}>
              <span>{label}</span>
              <input
                value={channel.environment?.[key] ?? ""}
                placeholder={zh ? "留空时跟随主模型" : "Falls back to the primary model"}
                onChange={(event) => onChange((current) => updateEnvironment(current, key, event.currentTarget.value))}
              />
            </label>
          ))}
          <label className="config-field">
            <span>{zh ? "思考强度" : "Effort level"}</span>
            <select
              value={channel.environment?.CLAUDE_CODE_EFFORT_LEVEL ?? "max"}
              onChange={(event) => onChange((current) => updateEnvironment(current, "CLAUDE_CODE_EFFORT_LEVEL", event.currentTarget.value))}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="max">Max</option>
            </select>
          </label>
        </>
      ) : null}

      {channel.agentId === "codex" ? (
        <>
          <label className="config-field">
            <span>{zh ? "上游 API 格式" : "Upstream API format"}</span>
            <select value={channel.apiFormat ?? "openai_responses"} onChange={(event) => updateApiFormat(event.currentTarget.value)}>
              <option value="openai_responses">OpenAI Responses</option>
              <option value="openai_chat">OpenAI Chat Completions</option>
            </select>
          </label>
          <label className="config-field">
            <span>Wire API</span>
            <select value={channel.wireApi ?? "responses"} onChange={(event) => onChange((current) => withOptionalString(current, "wireApi", event.currentTarget.value))}>
              <option value="responses">Responses</option>
              <option value="chat">Chat</option>
            </select>
          </label>
          <label className="config-field">
            <span>Reasoning</span>
            <select value={channel.modelReasoningEffort ?? ""} onChange={(event) => onChange((current) => withOptionalString(current, "modelReasoningEffort", event.currentTarget.value))}>
              <option value="">Default</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">XHigh</option>
              <option value="max">Max</option>
              <option value="ultra">Ultra</option>
            </select>
          </label>
          <label className="config-field config-field-wide">
            <span>{zh ? "模型目录文件" : "Model catalog file"}</span>
            <input value={channel.modelCatalogJson ?? ""} placeholder="/path/to/model-catalogs.json" onChange={(event) => onChange((current) => withOptionalString(current, "modelCatalogJson", event.currentTarget.value))} />
          </label>
        </>
      ) : null}

      {channel.agentId === "openclaw" ? (
        <label className="config-field config-field-wide">
          <span>Gateway Token</span>
          <input
            aria-label="OpenClaw Gateway Token"
            type={showSensitiveValues ? "text" : "password"}
            value={channel.environment?.OPENCLAW_GATEWAY_TOKEN ?? ""}
            onChange={(event) => onChange((current) => updateEnvironment(current, "OPENCLAW_GATEWAY_TOKEN", event.currentTarget.value))}
          />
        </label>
      ) : null}

      <label className="config-field config-field-wide">
        <span>User-Agent</span>
        <input value={channel.customUserAgent ?? ""} onChange={(event) => onChange((current) => withOptionalString(current, "customUserAgent", event.currentTarget.value))} />
      </label>
      <label className="config-field config-field-wide">
        <span>{zh ? "运行时环境变量（每行 KEY=VALUE）" : "Runtime environment (KEY=VALUE per line)"}</span>
        <textarea
          className={showSensitiveValues ? "" : "is-secret-masked"}
          value={environmentText}
          onChange={(event) => setEnvironmentText(event.currentTarget.value)}
          onBlur={() => {
            const environment = textToEnvironment(environmentText);
            onChange((current) => {
              const next = { ...current };
              if (environment) next.environment = environment;
              else delete next.environment;
              return next;
            });
          }}
        />
      </label>
      <label className="config-field config-field-wide">
        <span>{zh ? "供应商请求头（每行 KEY=VALUE）" : "Provider headers (KEY=VALUE per line)"}</span>
        <textarea
          className={showSensitiveValues ? "" : "is-secret-masked"}
          value={providerHeadersText}
          onChange={(event) => setProviderHeadersText(event.currentTarget.value)}
          onBlur={() => onChange((current) => withOptionalHeaders(current, providerHeadersText))}
        />
      </label>
      <label className="config-field config-field-wide">
        <span>{zh ? "请求头覆盖（JSON）" : "Request header overrides (JSON)"}</span>
        <textarea
          className={showSensitiveValues ? "" : "is-secret-masked"}
          value={overrideHeaders}
          onChange={(event) => setOverrideHeaders(event.currentTarget.value)}
          onBlur={() => commitRequestOverrides(overrideHeaders, overrideBody)}
        />
      </label>
      <label className="config-field config-field-wide">
        <span>{zh ? "请求体覆盖（JSON）" : "Request body overrides (JSON)"}</span>
        <textarea
          value={overrideBody}
          onChange={(event) => setOverrideBody(event.currentTarget.value)}
          onBlur={() => commitRequestOverrides(overrideHeaders, overrideBody)}
        />
      </label>
      {overrideError ? <div className="config-field-error config-field-wide">{overrideError}</div> : null}
    </div>
  );
}
