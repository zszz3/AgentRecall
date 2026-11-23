import { useState } from "react";
import type { ReactElement } from "react";
import {
  Check,
  Copy,
  Download,
  PlugZap,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { AgentModelImports } from "../../../../core/agent-model-config";
import type { SessionSource } from "../../../../core/types";
import {
  DEFAULT_GATEWAY_PORT,
  type GatewayAgentId,
  type GatewayProviderProtocol,
  type GatewayRouteTarget,
  type GatewaySnapshot,
} from "../../../../shared/ipc/model-gateway";
import { localize, type LanguageMode } from "../../language";
import { CatalogDetail } from "../../ui/catalog";
import { Badge, Button, Notice, Switch } from "../../ui/primitives";
import { AgentIcon } from "../sessions/agent-icon";

export type GatewaySectionView = "gateway-agents" | "gateway-providers" | "gateway-requests";

const AGENT_SOURCE_ICON: Record<GatewayAgentId, SessionSource> = {
  "claude-code": "claude-cli",
  codex: "codex-cli",
  "deepseek-harness": "deepseek-cli",
  pi: "pi-cli",
  opencode: "opencode-cli",
};

const GATEWAY_PRESETS: ReadonlyArray<{
  label: string;
  name: string;
  protocol: GatewayProviderProtocol;
  baseUrl: string;
  defaultModel: string;
}> = [
  { label: "DeepSeek", name: "DeepSeek", protocol: "openai_chat", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" },
  { label: "Anthropic", name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6" },
  { label: "OpenAI", name: "OpenAI", protocol: "openai_responses", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5" },
  { label: "Kimi / Moonshot", name: "Moonshot", protocol: "openai_chat", baseUrl: "https://api.moonshot.cn/v1", defaultModel: "kimi-k2.5" },
  { label: "OpenRouter", name: "OpenRouter", protocol: "openai_chat", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "anthropic/claude-sonnet-4-6" },
  { label: "Ollama (本地)", name: "Ollama", protocol: "openai_chat", baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "qwen3-coder" },
];

function encodeRoute(target: GatewayRouteTarget | null): string {
  return target ? `${target.providerId}::${target.model}` : "";
}

function decodeRoute(value: string): GatewayRouteTarget | null {
  if (!value) return null;
  const idx = value.indexOf("::");
  if (idx <= 0) return null;
  const providerId = value.slice(0, idx);
  const model = value.slice(idx + 2);
  return providerId && model ? { providerId, model } : null;
}

function protocolLabel(protocol: GatewayProviderProtocol): string {
  if (protocol === "anthropic") return "Anthropic Messages";
  if (protocol === "openai_responses") return "OpenAI Responses";
  return "OpenAI Chat";
}

function mapImportApi(api: string): GatewayProviderProtocol {
  if (api === "anthropic-messages") return "anthropic";
  if (api === "openai-responses") return "openai_responses";
  return "openai_chat";
}

export function GatewayPanel({
  view,
  snapshot,
  imports,
  language,
  busy,
  feedback,
  onSetEnabled,
  onSaveProvider,
  onRemoveProvider,
  onSetRouting,
  onSetAgentModel,
  onWireAgent,
  onRestoreAgent,
  onClearRequests,
}: {
  view: GatewaySectionView;
  snapshot: GatewaySnapshot | null;
  imports: AgentModelImports | null;
  language: LanguageMode;
  busy: boolean;
  feedback: { kind: "success" | "error"; message: string } | null;
  onSetEnabled: (enabled: boolean, port?: number) => Promise<void>;
  onSaveProvider: (input: {
    id?: string;
    name: string;
    protocol: GatewayProviderProtocol;
    baseUrl: string;
    defaultModel: string;
    apiKey?: string;
    importId?: string;
  }) => Promise<void>;
  onRemoveProvider: (providerId: string) => Promise<void>;
  onSetRouting: (primary: GatewayRouteTarget | null, fallbacks: GatewayRouteTarget[]) => Promise<void>;
  onSetAgentModel: (agentId: GatewayAgentId, target: GatewayRouteTarget | null) => Promise<void>;
  onWireAgent: (agentId: GatewayAgentId) => Promise<void>;
  onRestoreAgent: (agentId: GatewayAgentId) => Promise<void>;
  onClearRequests: () => Promise<void>;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [portInput, setPortInput] = useState(String(snapshot?.config.port ?? DEFAULT_GATEWAY_PORT));
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Provider creation draft
  const [draftName, setDraftName] = useState("");
  const [draftProtocol, setDraftProtocol] = useState<GatewayProviderProtocol>("openai_chat");
  const [draftBaseUrl, setDraftBaseUrl] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [draftImportId, setDraftImportId] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  if (!snapshot) {
    return (
      <CatalogDetail
        title={l("Local Model Gateway", "本地模型网关")}
        subtitle={l("Loading local gateway state…", "正在加载本地模型网关状态…")}
      />
    );
  }

  const routeOptions: Array<{ value: string; label: string }> = [];
  for (const provider of snapshot.config.providers) {
    const models = provider.models.length > 0 ? provider.models : [provider.defaultModel];
    for (const model of models) {
      routeOptions.push({
        value: encodeRoute({ providerId: provider.id, model }),
        label: `${provider.name} / ${model}`,
      });
    }
  }

  const copyText = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(key);
      window.setTimeout(() => setCopiedId((cur) => (cur === key ? null : cur)), 1600);
    }).catch(() => undefined);
  };

  if (view === "gateway-agents") {
    const parsedPort = Number(portInput);
    const validPort = Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535
      ? parsedPort
      : snapshot.config.port;

    return (
      <CatalogDetail
        title={l("Local Model Gateway & Agent Wiring", "本地模型网关与 Agent 接入")}
        subtitle={l(
          "Route local coding agents through one gateway for unified model switching, protocol translation, fallback, and zero-latency Dynamic Island alerts.",
          "用本机网关统一接管编码 Agent 的模型流量：支持协议互转、备用容灾、实时请求日志，以及零延迟灵动岛完成提醒。",
        )}
        facts={[
          {
            label: l("Status", "状态"),
            value: snapshot.status.running
              ? l(`Running · ${snapshot.status.baseUrl}`, `运行中 · ${snapshot.status.baseUrl}`)
              : l("Stopped", "未启动"),
          },
          {
            label: l("Primary route", "默认路由"),
            value: snapshot.config.primary
              ? `${snapshot.config.providers.find((p) => p.id === snapshot.config.primary?.providerId)?.name ?? snapshot.config.primary.providerId} / ${snapshot.config.primary.model}`
              : l("Not configured", "未配置（请先添加上游 Provider）"),
          },
        ]}
        actions={
          <div className="gateway-head-actions">
            <Badge tone={snapshot.status.running ? "success" : "neutral"}>
              <PlugZap size={12} />
              {snapshot.status.running ? l("Running", "运行中") : l("Stopped", "已停止")}
            </Badge>
            <Switch
              checked={snapshot.config.enabled}
              disabled={busy}
              label={l("Enable local model gateway", "开启本地模型网关")}
              onChange={(checked) => void onSetEnabled(checked, validPort)}
            />
          </div>
        }
      >
        {feedback ? <Notice kind={feedback.kind}>{feedback.message}</Notice> : null}
        {snapshot.status.error ? <Notice kind="error">{snapshot.status.error}</Notice> : null}

        <section className="gateway-card">
          <div className="gateway-card-head">
            <h4>{l("Gateway Endpoint", "网关地址与端口")}</h4>
            <Button
              size="sm"
              variant="ghost"
              icon={copiedId === "token" ? <Check size={13} /> : <Copy size={13} />}
              onClick={() => copyText("token", snapshot.status.localToken)}
            >
              {copiedId === "token" ? l("Copied token", "已复制本地密钥") : l("Copy local token", "复制本地密钥")}
            </Button>
          </div>
          <div className="gateway-port-row">
            <label className="gateway-inline-field">
              <span>{l("Listen port", "监听端口")}</span>
              <input
                type="number"
                min={1024}
                max={65535}
                value={portInput}
                disabled={busy}
                onChange={(event) => setPortInput(event.target.value)}
              />
            </label>
            <Button
              size="sm"
              disabled={busy || validPort === snapshot.config.port}
              onClick={() => void onSetEnabled(snapshot.config.enabled, validPort)}
            >
              {l("Apply port", "应用端口")}
            </Button>
            <code className="gateway-endpoint-code">{snapshot.status.baseUrl}</code>
          </div>
        </section>

        <section className="gateway-card">
          <div className="gateway-card-head">
            <h4>{l("Write Gateway Config to Agents", "一键写入 Agent 配置文件")}</h4>
            <span className="gateway-card-hint">
              {l(
                "Writing saves a backup first so Restore brings back your previous config cleanly.",
                "写入前会自动备份原配置，点击「还原」即可无损恢复。",
              )}
            </span>
          </div>
          <div className="gateway-agent-list">
            {snapshot.agents.map((agent) => (
              <div key={agent.agentId} className="gateway-agent-row" data-agent={agent.agentId}>
                <div className="gateway-agent-info">
                  <AgentIcon source={AGENT_SOURCE_ICON[agent.agentId]} size={18} />
                  <div className="gateway-agent-copy">
                    <div className="gateway-agent-title-row">
                      <strong>{agent.label}</strong>
                      {agent.wired ? (
                        <Badge tone="success">{l("Wired", "已写入网关")}</Badge>
                      ) : agent.detected ? (
                        <Badge tone="neutral">{l("Detected", "已检测到")}</Badge>
                      ) : (
                        <Badge tone="neutral">{l("Not found", "未检测到目录")}</Badge>
                      )}
                    </div>
                    <span className="gateway-agent-summary">{agent.currentSummary}</span>
                    <span className="gateway-agent-path">{agent.configPath}</span>
                  </div>
                </div>
                <div className="gateway-agent-controls">
                  {routeOptions.length > 0 ? (
                    <select
                      aria-label={l(`${agent.label} model route`, `${agent.label} 模型路由`)}
                      className="gateway-route-select"
                      disabled={busy}
                      value={encodeRoute(agent.routeOverride)}
                      onChange={(event) => void onSetAgentModel(agent.agentId, decodeRoute(event.target.value))}
                    >
                      <option value="">{l("Follow gateway default", "跟随网关默认路由")}</option>
                      {routeOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : null}
                  <Button
                    size="sm"
                    variant={agent.wired ? "secondary" : "primary"}
                    disabled={busy}
                    onClick={() => void onWireAgent(agent.agentId)}
                  >
                    {agent.wired ? l("Re-write config", "重新写入") : l("Write config", "写入配置")}
                  </Button>
                  {agent.hasBackup ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<RotateCcw size={13} />}
                      disabled={busy}
                      onClick={() => void onRestoreAgent(agent.agentId)}
                    >
                      {l("Restore", "还原")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={copiedId === agent.agentId ? <Check size={13} /> : <Copy size={13} />}
                    onClick={() => copyText(agent.agentId, agent.snippet)}
                  >
                    {copiedId === agent.agentId ? l("Copied", "已复制") : l("Env", "环境变量")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </CatalogDetail>
    );
  }

  if (view === "gateway-providers") {
    const primaryValue = encodeRoute(snapshot.config.primary);
    const fallbackValue = encodeRoute(snapshot.config.fallbacks[0] ?? null);

    const handleAddProvider = async () => {
      setLocalError(null);
      if (!draftName.trim() || !draftBaseUrl.trim() || !draftModel.trim()) {
        setLocalError(l("Fill in name, base URL and default model.", "请填写名称、接口地址和默认模型。"));
        return;
      }
      await onSaveProvider({
        name: draftName.trim(),
        protocol: draftProtocol,
        baseUrl: draftBaseUrl.trim(),
        defaultModel: draftModel.trim(),
        ...(draftApiKey.trim() ? { apiKey: draftApiKey.trim() } : {}),
        ...(draftImportId ? { importId: draftImportId } : {}),
      });
      setDraftName("");
      setDraftBaseUrl("");
      setDraftModel("");
      setDraftApiKey("");
      setDraftImportId("");
    };

    return (
      <CatalogDetail
        title={l("Gateway Upstream Providers & Routing", "上游 Providers 与容灾路由")}
        subtitle={l(
          "Configure upstream model services once for every wired agent. When the primary route hits 429 or 5xx, the gateway automatically switches to the fallback.",
          "配置一次上游模型服务即可供所有接入网关的 Agent 共用；主路由遇到 429 限流或 5xx 时自动切往备用路由。",
        )}
      >
        {feedback ? <Notice kind={feedback.kind}>{feedback.message}</Notice> : null}
        {localError ? <Notice kind="error">{localError}</Notice> : null}

        <section className="gateway-card">
          <div className="gateway-card-head">
            <h4>{l("Default & Fallback Route", "默认路由与备用容灾")}</h4>
          </div>
          {routeOptions.length === 0 ? (
            <p className="gateway-empty-text">
              {l("Add at least one upstream provider below to configure routing.", "请在下方先添加至少一个上游 Provider。")}
            </p>
          ) : (
            <div className="gateway-routing-grid">
              <label className="gateway-stack-field">
                <span>{l("Primary route", "主路由")}</span>
                <select
                  value={primaryValue}
                  disabled={busy}
                  onChange={(event) => {
                    const nextPrimary = decodeRoute(event.target.value);
                    const nextFallbacks = snapshot.config.fallbacks.filter((f) => encodeRoute(f) !== event.target.value);
                    void onSetRouting(nextPrimary, nextFallbacks);
                  }}
                >
                  <option value="">{l("Select primary model…", "选择主模型…")}</option>
                  {routeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              <label className="gateway-stack-field">
                <span>{l("Fallback route (on 429 / 5xx)", "备用路由（429 / 5xx 自动切换）")}</span>
                <select
                  value={fallbackValue}
                  disabled={busy}
                  onChange={(event) => {
                    const nextFallback = decodeRoute(event.target.value);
                    void onSetRouting(snapshot.config.primary, nextFallback ? [nextFallback] : []);
                  }}
                >
                  <option value="">{l("No fallback", "不启用备用")}</option>
                  {routeOptions.filter((opt) => opt.value !== primaryValue).map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </section>

        <section className="gateway-card">
          <div className="gateway-card-head">
            <h4>{l("Configured Upstream Providers", "已配置的上游 Providers")}</h4>
          </div>
          {snapshot.config.providers.length === 0 ? (
            <p className="gateway-empty-text">
              {l("No gateway providers saved yet.", "尚未添加网关上游 Provider。")}
            </p>
          ) : (
            <div className="gateway-provider-list">
              {snapshot.config.providers.map((provider) => (
                <div key={provider.id} className="gateway-provider-row">
                  <div className="gateway-provider-meta">
                    <div className="gateway-agent-title-row">
                      <strong>{provider.name}</strong>
                      <Badge tone="neutral">{protocolLabel(provider.protocol)}</Badge>
                      <Badge tone={provider.hasApiKey ? "success" : "warning"}>
                        {provider.hasApiKey ? l("Key saved", "已存密钥") : l("No key", "无密钥")}
                      </Badge>
                    </div>
                    <span className="gateway-agent-summary">
                      {provider.baseUrl} · {provider.defaultModel}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={13} />}
                    disabled={busy}
                    onClick={() => void onRemoveProvider(provider.id)}
                  >
                    {l("Remove", "删除")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="gateway-card">
          <div className="gateway-card-head">
            <h4>{l("Add Upstream Provider", "添加上游 Provider")}</h4>
          </div>
          <div className="gateway-preset-row">
            {GATEWAY_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="gateway-preset-chip"
                disabled={busy}
                onClick={() => {
                  setDraftName(preset.name);
                  setDraftProtocol(preset.protocol);
                  setDraftBaseUrl(preset.baseUrl);
                  setDraftModel(preset.defaultModel);
                  setDraftImportId("");
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {imports && imports.imports.length > 0 ? (
            <label className="gateway-stack-field">
              <span className="gateway-import-label">
                <Download size={13} />
                {l("Or import from local agents / CC Switch", "或直接从本机 Agent / CC Switch 导入")}
              </span>
              <select
                value={draftImportId}
                disabled={busy}
                onChange={(event) => {
                  const id = event.target.value;
                  setDraftImportId(id);
                  const found = imports.imports.find((item) => item.id === id);
                  if (!found) return;
                  const firstChoice = found.choices[0];
                  setDraftName(found.name);
                  if (firstChoice) {
                    setDraftProtocol(mapImportApi(firstChoice.config.api));
                    setDraftBaseUrl(firstChoice.config.baseUrl || `https://${found.host}`);
                    setDraftModel(firstChoice.config.model);
                  }
                }}
              >
                <option value="">{l("Choose an imported service…", "选择一个检测到的本机服务…")}</option>
                {imports.imports.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.host} ({item.sources.join(" / ")})
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="gateway-form-grid">
            <label className="gateway-stack-field">
              <span>{l("Name", "名称")}</span>
              <input
                value={draftName}
                disabled={busy}
                placeholder={l("e.g. DeepSeek Production", "例如：DeepSeek 主力")}
                onChange={(event) => setDraftName(event.target.value)}
              />
            </label>
            <label className="gateway-stack-field">
              <span>{l("Protocol", "上游协议")}</span>
              <select
                value={draftProtocol}
                disabled={busy}
                onChange={(event) => setDraftProtocol(event.target.value as GatewayProviderProtocol)}
              >
                <option value="openai_chat">OpenAI Chat Completions</option>
                <option value="openai_responses">OpenAI Responses</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </label>
            <label className="gateway-stack-field">
              <span>{l("Base URL", "接口地址")}</span>
              <input
                value={draftBaseUrl}
                disabled={busy}
                placeholder="https://api.deepseek.com/v1"
                onChange={(event) => setDraftBaseUrl(event.target.value)}
              />
            </label>
            <label className="gateway-stack-field">
              <span>{l("Default Model", "默认模型")}</span>
              <input
                value={draftModel}
                disabled={busy}
                placeholder="deepseek-chat"
                onChange={(event) => setDraftModel(event.target.value)}
              />
            </label>
            <label className="gateway-stack-field gateway-field-full">
              <span>{l("API Key", "API Key")}</span>
              <input
                type="password"
                value={draftApiKey}
                disabled={busy}
                placeholder={draftImportId
                  ? l("Will copy key from the selected local agent import", "保存时将自动复制所选导入服务的密钥")
                  : "sk-..."}
                onChange={(event) => setDraftApiKey(event.target.value)}
              />
            </label>
          </div>
          <div className="gateway-form-actions">
            <Button
              size="sm"
              variant="primary"
              icon={<Plus size={14} />}
              disabled={busy}
              onClick={() => void handleAddProvider()}
            >
              {l("Save gateway provider", "保存上游 Provider")}
            </Button>
          </div>
        </section>
      </CatalogDetail>
    );
  }

  // gateway-requests
  return (
    <CatalogDetail
      title={l("Gateway Request Log", "网关实时请求日志")}
      subtitle={l(
        "Live requests routed through AgentRecall's local gateway. API keys are never logged.",
        "经过 AgentRecall 本地网关的最近请求记录（最多保留 100 条，绝不记录密钥）。",
      )}
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 size={13} />}
          disabled={busy || snapshot.requests.length === 0}
          onClick={() => void onClearRequests()}
        >
          {l("Clear log", "清空日志")}
        </Button>
      }
    >
      {snapshot.requests.length === 0 ? (
        <section className="gateway-card">
          <p className="gateway-empty-text">
            {l(
              "No requests captured yet. Enable the gateway and wire an agent to observe live calls here.",
              "暂无请求记录。开启网关并接入至少一个 Agent 后，实时请求会出现在这里。",
            )}
          </p>
        </section>
      ) : (
        <div className="gateway-request-list">
          {snapshot.requests.map((req) => (
            <div key={req.id} className="gateway-request-row">
              <div className="gateway-request-top">
                <Badge tone={req.statusCode >= 400 ? "danger" : "success"}>HTTP {req.statusCode}</Badge>
                <strong>{req.agentId}</strong>
                <span className="gateway-request-route">
                  {req.upstreamProviderName} / {req.upstreamModel}
                </span>
                {req.fallbackUsed ? <Badge tone="warning">{l("Fallback", "已切换备用")}</Badge> : null}
                <span className="gateway-request-time">
                  {new Date(req.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="gateway-request-metrics">
                <span>{l("Duration", "耗时")} {req.durationMs}ms</span>
                {req.ttftMs !== null ? <span>TTFT {req.ttftMs}ms</span> : null}
                <span>
                  {l("Tokens", "用量")} {req.inputTokens + req.cachedInputTokens} in
                  {req.cachedInputTokens > 0 ? ` (${req.cachedInputTokens} cached)` : ""} / {req.outputTokens} out
                </span>
                {req.stopReason ? <span>{req.stopReason}</span> : null}
              </div>
              {req.error ? <p className="gateway-request-error">{req.error}</p> : null}
            </div>
          ))}
        </div>
      )}
    </CatalogDetail>
  );
}
