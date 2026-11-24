import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Pencil,
  PlugZap,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type { AgentModelImport, AgentModelImports } from "../../../../core/agent-model-config";
import type { SessionSource } from "../../../../core/types";
import {
  DEFAULT_GATEWAY_PORT,
  type GatewayAgentId,
  type GatewayProviderEntry,
  type GatewayProviderProtocol,
  type GatewayProviderTestResult,
  type GatewayRouteTarget,
  type GatewaySnapshot,
} from "../../../../shared/ipc/model-gateway";
import { localize, type LanguageMode } from "../../language";
import { Badge, Button, Notice, Switch } from "../../ui/primitives";
import { AgentIcon } from "../sessions/agent-icon";

export type GatewaySectionView = "gateway-overview" | "gateway-requests";

const AGENT_SOURCE_ICON: Record<GatewayAgentId, SessionSource> = {
  "claude-code": "claude-cli",
  codex: "codex-cli",
  "deepseek-harness": "deepseek-cli",
  pi: "pi-cli",
  opencode: "opencode-cli",
};

const IMPORT_SOURCE_LABELS: Record<string, string> = {
  zcode: "ZCode",
  dsh: "DeepSeek Harness",
  codex: "Codex",
  claude: "Claude Code",
  "cc-switch": "CC Switch",
  pi: "Pi",
  stepcode: "StepCode",
  opencode: "OpenCode",
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

function protocolShort(protocol: GatewayProviderProtocol): string {
  if (protocol === "anthropic") return "Anthropic";
  if (protocol === "openai_responses") return "Responses";
  return "OpenAI Chat";
}

function mapImportApi(api: string): GatewayProviderProtocol {
  if (api === "anthropic-messages") return "anthropic";
  if (api === "openai-responses") return "openai_responses";
  return "openai_chat";
}

function buildImportPayload(item: AgentModelImport): {
  name: string;
  protocol: GatewayProviderProtocol;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  importId: string;
} | null {
  const first = item.choices[0];
  if (!first) return null;
  const models = [...new Set(item.choices.map((c) => c.config.model).filter(Boolean))];
  const baseUrl = first.config.baseUrl?.trim()
    || (first.config.api === "anthropic-messages" ? `https://${item.host}` : `https://${item.host}/v1`);
  return {
    name: item.name,
    protocol: mapImportApi(first.config.api),
    baseUrl,
    defaultModel: first.config.model,
    models,
    importId: item.id,
  };
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
  onTestProvider,
  onSetRouting,
  onSetAgentModel,
  onSetAgentRecallModel,
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
    models?: string[];
    enabled?: boolean;
    apiKey?: string;
    importId?: string;
  }) => Promise<void>;
  onRemoveProvider: (providerId: string) => Promise<void>;
  onTestProvider?: (providerId: string) => Promise<GatewayProviderTestResult>;
  onSetRouting: (primary: GatewayRouteTarget | null, fallbacks: GatewayRouteTarget[]) => Promise<void>;
  onSetAgentModel: (agentId: GatewayAgentId, target: GatewayRouteTarget | null) => Promise<void>;
  onSetAgentRecallModel?: (target: GatewayRouteTarget | null) => Promise<void>;
  onWireAgent: (agentId: GatewayAgentId) => Promise<void>;
  onRestoreAgent: (agentId: GatewayAgentId) => Promise<void>;
  onClearRequests: () => Promise<void>;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [portInput, setPortInput] = useState(String(snapshot?.config.port ?? DEFAULT_GATEWAY_PORT));
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Progressive disclosure for adding / editing an upstream model service
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftProtocol, setDraftProtocol] = useState<GatewayProviderProtocol>("openai_chat");
  const [draftBaseUrl, setDraftBaseUrl] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const [draftExtraModels, setDraftExtraModels] = useState("");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, GatewayProviderTestResult>>({});

  useEffect(() => {
    if (snapshot?.config.port !== undefined) {
      setPortInput(String(snapshot.config.port));
    }
  }, [snapshot?.config.port]);

  if (!snapshot) {
    return (
      <div className="gateway-flow">
        <section className="gateway-card">
          <p className="gateway-empty-text">
            {l("Loading local gateway state…", "正在加载本地模型网关状态…")}
          </p>
        </section>
      </div>
    );
  }

  const routeOptions: Array<{ value: string; label: string }> = [];
  for (const provider of snapshot.config.providers) {
    if (!provider.enabled) continue;
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

  if (view === "gateway-requests") {
    return (
      <div className="gateway-flow">
        <header className="gateway-section-banner">
          <div>
            <h3>{l("Gateway Request Log", "实时请求日志")}</h3>
            <p className="gateway-card-hint">
              {l(
                "Recent model calls routed through the local gateway. Keys are never logged.",
                "经本机网关转发的最近模型调用（最多保留 100 条，绝不记录密钥）。",
              )}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 size={13} />}
            disabled={busy || snapshot.requests.length === 0}
            onClick={() => void onClearRequests()}
          >
            {l("Clear log", "清空日志")}
          </Button>
        </header>
        {snapshot.requests.length === 0 ? (
          <section className="gateway-card">
            <p className="gateway-empty-text">
              {l(
                "No requests captured yet. Connect an agent in Local Gateway and send a prompt to see live traffic here.",
                "暂无请求记录。在「模型网关」中接入任意 Agent 后发一条消息，实时流量和耗时就会显示在这里。",
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
                  {req.fallbackUsed ? <Badge tone="warning">{l("Fallback", "已切备用")}</Badge> : null}
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
      </div>
    );
  }

  // Unified "gateway-overview" view: Step 1 (Model Services) -> Step 2 (Connect Agents) -> Advanced (collapsed)
  const parsedPort = Number(portInput);
  const validPort = Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535
    ? parsedPort
    : snapshot.config.port;
  const hasProviders = snapshot.config.providers.length > 0;
  const hasWiredWhileStopped = !snapshot.status.running && snapshot.agents.some((agent) => agent.wired);
  const primaryValue = encodeRoute(snapshot.config.primary);
  const fallbackValue = encodeRoute(snapshot.config.fallbacks[0] ?? null);
  const primaryLabel = snapshot.config.primary
    ? `${snapshot.config.providers.find((p) => p.id === snapshot.config.primary?.providerId)?.name ?? snapshot.config.primary.providerId} / ${snapshot.config.primary.model}`
    : "";
  const curlSnippet = `curl -s ${snapshot.status.baseUrl}/v1/models -H "Authorization: Bearer ${snapshot.status.localToken}"`;

  // Filter local detected imports to ones not already added (by normalized baseUrl / name)
  const existingHosts = new Set(
    snapshot.config.providers.map((p) => {
      try { return new URL(p.baseUrl).host.toLowerCase(); } catch { return p.name.toLowerCase(); }
    }),
  );
  const suggestedImports = (imports?.imports ?? []).filter(
    (item) => !existingHosts.has(item.host.toLowerCase()) && Boolean(item.choices[0]),
  );

  const resetEditor = () => {
    setEditorOpen(false);
    setEditingId(null);
    setDraftName("");
    setDraftProtocol("openai_chat");
    setDraftBaseUrl("");
    setDraftModel("");
    setDraftExtraModels("");
    setDraftApiKey("");
    setLocalError(null);
  };

  const openAddEditor = () => {
    setEditingId(null);
    setDraftName("");
    setDraftProtocol("openai_chat");
    setDraftBaseUrl("");
    setDraftModel("");
    setDraftExtraModels("");
    setDraftApiKey("");
    setLocalError(null);
    setEditorOpen(true);
  };

  const openEditEditor = (provider: GatewayProviderEntry) => {
    setEditingId(provider.id);
    setDraftName(provider.name);
    setDraftProtocol(provider.protocol);
    setDraftBaseUrl(provider.baseUrl);
    setDraftModel(provider.defaultModel);
    setDraftExtraModels(provider.models.filter((m) => m !== provider.defaultModel).join(", "));
    setDraftApiKey("");
    setLocalError(null);
    setEditorOpen(true);
  };

  const handleSaveDraft = async () => {
    setLocalError(null);
    if (!draftName.trim() || !draftBaseUrl.trim() || !draftModel.trim()) {
      setLocalError(l("Fill in service name, base URL and model.", "请填写服务名称、接口地址和默认模型。"));
      return;
    }
    const extraModels = draftExtraModels
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    await onSaveProvider({
      ...(editingId ? { id: editingId } : {}),
      name: draftName.trim(),
      protocol: draftProtocol,
      baseUrl: draftBaseUrl.trim(),
      defaultModel: draftModel.trim(),
      ...(extraModels.length > 0 ? { models: [draftModel.trim(), ...extraModels] } : {}),
      ...(draftApiKey.trim() ? { apiKey: draftApiKey.trim() } : {}),
    });
    resetEditor();
  };

  const handleQuickImport = async (item: AgentModelImport) => {
    const payload = buildImportPayload(item);
    if (!payload) return;
    await onSaveProvider(payload);
  };

  const handleTestProvider = async (providerId: string) => {
    if (!onTestProvider) return;
    setTestingId(providerId);
    try {
      const result = await onTestProvider(providerId);
      setTestResults((current) => ({ ...current, [providerId]: result }));
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [providerId]: {
          ok: false,
          statusCode: null,
          latencyMs: 0,
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setTestingId((cur) => (cur === providerId ? null : cur));
    }
  };

  const sortedAgents = [...snapshot.agents].sort((left, right) => {
    const rank = (agent: typeof left) => (agent.wired ? 0 : agent.detected ? 1 : 2);
    return rank(left) - rank(right) || left.label.localeCompare(right.label);
  });

  return (
    <div className="gateway-flow">
      <header className="gateway-status-banner">
        <div className="gateway-status-copy">
          <div className="gateway-status-title-row">
            <span className={`gateway-status-dot${snapshot.status.running ? " is-live" : ""}`} aria-hidden="true" />
            <h3>{l("Local Model Gateway", "本地模型网关")}</h3>
            <Badge tone={snapshot.status.running ? "success" : "neutral"}>
              <PlugZap size={12} />
              {snapshot.status.running
                ? l(`Running :${snapshot.status.port}`, `运行中 :${snapshot.status.port}`)
                : l("Off", "未开启")}
            </Badge>
          </div>
          <p className="gateway-card-hint">
            {l(
              "Configure model services once, assign default & built-in AI routing, then wire local coding agents in one click.",
              "三步完成统一模型管理：配置上游 API → 指定默认路由与内置 AI → 一键接入本机 Agent 并触发灵动岛提醒。",
            )}
          </p>
        </div>
        <div className="gateway-head-actions">
          <Switch
            checked={snapshot.config.enabled}
            disabled={busy}
            label={l("Enable local model gateway", "开启本地模型网关")}
            onChange={(checked) => void onSetEnabled(checked, validPort)}
          />
        </div>
      </header>

      {feedback ? <Notice kind={feedback.kind}>{feedback.message}</Notice> : null}
      {localError ? <Notice kind="error">{localError}</Notice> : null}
      {snapshot.status.error ? <Notice kind="error">{snapshot.status.error}</Notice> : null}

      {hasWiredWhileStopped ? (
        <Notice kind="warning">
          <span className="gateway-notice-row">
            <span>
              {l(
                "Some agents point to this gateway while it is turned off.",
                "已有 Agent 接入了本机网关，但网关当前未开启。",
              )}
            </span>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void onSetEnabled(true, validPort)}>
              {l("Turn on gateway", "立即开启网关")}
            </Button>
          </span>
        </Notice>
      ) : null}

      {/* Step 1: Model Services (Upstreams) */}
      <section className="gateway-card">
        <div className="gateway-card-head">
          <div className="gateway-step-title">
            <span className="gateway-step-badge">1</span>
            <div>
              <h4>{l("Model services", "准备模型服务（上游 API）")}</h4>
              <p className="gateway-card-hint">
                {hasProviders
                  ? l("Shared by AgentRecall built-in AI and all local agents connected below.", "供下方默认路由、内置功能与所有已接入 Agent 共用。")
                  : l("Import an existing service from your local agents in one click, or add an API key.", "先一键导入本机已配置好的服务，或手动添加一个模型 API Key。")}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant={hasProviders ? "secondary" : "primary"}
            icon={editorOpen ? <X size={13} /> : <Plus size={13} />}
            disabled={busy}
            onClick={() => (editorOpen ? resetEditor() : openAddEditor())}
          >
            {editorOpen ? l("Close", "收起") : l("Add service", "添加服务")}
          </Button>
        </div>

        {/* One-click discovery bar (Magpie style) */}
        {suggestedImports.length > 0 ? (
          <div className="gateway-discovery">
            <div className="gateway-discovery-head">
              <Sparkles size={13} aria-hidden="true" />
              <span>
                {l(
                  `Found ${suggestedImports.length} model service(s) already configured on this Mac`,
                  `发现本机已有 ${suggestedImports.length} 个可用模型服务，点击即可直接导入（含密钥）：`,
                )}
              </span>
            </div>
            <div className="gateway-discovery-chips">
              {suggestedImports.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="gateway-import-chip"
                  disabled={busy}
                  onClick={() => void handleQuickImport(item)}
                >
                  <Download size={12} aria-hidden="true" />
                  <strong>{item.name}</strong>
                  <span>{item.choices[0]?.config.model} · {item.sources.map((src) => IMPORT_SOURCE_LABELS[src] ?? src).join("/")}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Existing configured upstream services */}
        {hasProviders ? (
          <div className="gateway-provider-list">
            {snapshot.config.providers.map((provider) => {
              const isPrimary = snapshot.config.primary?.providerId === provider.id;
              const testResult = testResults[provider.id];
              return (
                <div key={provider.id} className="gateway-provider-row">
                  <div className="gateway-provider-meta">
                    <div className="gateway-agent-title-row">
                      <strong>{provider.name}</strong>
                      <Badge tone="neutral">{protocolShort(provider.protocol)}</Badge>
                      {isPrimary ? <Badge tone="accent">{l("Default", "默认")}</Badge> : null}
                      {!provider.hasApiKey ? <Badge tone="warning">{l("No key", "缺密钥")}</Badge> : null}
                    </div>
                    <span className="gateway-agent-summary">
                      {provider.models.join(", ")} · {provider.baseUrl}
                    </span>
                    {testResult ? (
                      <span className={`gateway-test-result ${testResult.ok ? "is-ok" : "is-fail"}`}>
                        {testResult.message}
                      </span>
                    ) : null}
                  </div>
                  <div className="gateway-agent-controls">
                    {!isPrimary ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void onSetRouting(
                          { providerId: provider.id, model: provider.defaultModel },
                          snapshot.config.fallbacks.filter((f) => f.providerId !== provider.id),
                        )}
                      >
                        {l("Set default", "设为默认")}
                      </Button>
                    ) : null}
                    {onTestProvider ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Zap size={13} />}
                        disabled={busy || testingId === provider.id}
                        onClick={() => void handleTestProvider(provider.id)}
                      >
                        {testingId === provider.id ? l("Testing…", "测试中…") : l("Test", "测试")}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Pencil size={13} />}
                      disabled={busy}
                      onClick={() => openEditEditor(provider)}
                    >
                      {l("Edit", "编辑")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={13} />}
                      disabled={busy}
                      onClick={() => {
                        if (editingId === provider.id) resetEditor();
                        void onRemoveProvider(provider.id);
                      }}
                    >
                      {l("Remove", "删除")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : !editorOpen ? (
          <p className="gateway-empty-text">
            {l(
              "No model services yet. Click a detected service above or 'Add service' to begin.",
              "还没有模型服务。点击上方一键导入，或点右上角「添加服务」填入 API Key。",
            )}
          </p>
        ) : null}

        {/* Progressive-disclosure add/edit drawer */}
        {editorOpen ? (
          <div className="gateway-editor-sheet">
            {!editingId ? (
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
                      setDraftExtraModels("");
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="gateway-form-grid">
              <label className="gateway-stack-field">
                <span>{l("Name", "名称")}</span>
                <input
                  value={draftName}
                  disabled={busy}
                  placeholder={l("e.g. DeepSeek", "例如：DeepSeek")}
                  onChange={(event) => setDraftName(event.target.value)}
                />
              </label>
              <label className="gateway-stack-field">
                <span>{l("Protocol", "接口协议")}</span>
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
                <span>{l("Model", "默认模型")}</span>
                <input
                  value={draftModel}
                  disabled={busy}
                  placeholder="deepseek-chat"
                  onChange={(event) => setDraftModel(event.target.value)}
                />
              </label>
              <label className="gateway-stack-field">
                <span>{l("More models (optional)", "其他可选模型（逗号分隔，可留空）")}</span>
                <input
                  value={draftExtraModels}
                  disabled={busy}
                  placeholder="deepseek-reasoner"
                  onChange={(event) => setDraftExtraModels(event.target.value)}
                />
              </label>
              <label className="gateway-stack-field">
                <span>{l("API Key", "API Key")}</span>
                <input
                  type="password"
                  value={draftApiKey}
                  disabled={busy}
                  placeholder={editingId ? l("Leave blank to keep saved key", "留空保留现有密钥") : "sk-..."}
                  onChange={(event) => setDraftApiKey(event.target.value)}
                />
              </label>
            </div>
            <div className="gateway-form-actions">
              <Button size="sm" variant="ghost" disabled={busy} onClick={resetEditor}>
                {l("Cancel", "取消")}
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void handleSaveDraft()}>
                {editingId ? l("Save changes", "保存修改") : l("Save service", "保存服务")}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Step 2: Default Routing & Built-in AI */}
      <section className="gateway-card">
        <div className="gateway-card-head">
          <div className="gateway-step-title">
            <span className="gateway-step-badge">2</span>
            <div>
              <h4>{l("Default routing & built-in AI", "默认路由与内置 AI")}</h4>
              <p className="gateway-card-hint">
                {l(
                  "Choose the default model, optional 429/5xx fallback, and the model for AgentRecall's built-in AI features.",
                  "设置默认模型与限流容灾备用；AgentRecall 内置功能会直接复用这里的配置，无需开启网关端口。",
                )}
              </p>
            </div>
          </div>
        </div>

        {routeOptions.length > 0 ? (
          <div className="gateway-route-bar">
            <label className="gateway-route-field">
              <span>{l("Default model", "默认模型")}</span>
              <select
                value={primaryValue}
                disabled={busy}
                onChange={(event) => {
                  const nextPrimary = decodeRoute(event.target.value);
                  const nextFallbacks = snapshot.config.fallbacks.filter((f) => encodeRoute(f) !== event.target.value);
                  void onSetRouting(nextPrimary, nextFallbacks);
                }}
              >
                <option value="">{l("Select…", "请选择…")}</option>
                {routeOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
            {routeOptions.length > 1 ? (
              <label className="gateway-route-field">
                <span>{l("Fallback (429 / 5xx)", "限流/报错自动切备用")}</span>
                <select
                  value={fallbackValue}
                  disabled={busy}
                  onChange={(event) => {
                    const nextFallback = decodeRoute(event.target.value);
                    void onSetRouting(snapshot.config.primary, nextFallback ? [nextFallback] : []);
                  }}
                >
                  <option value="">{l("None", "不启用备用")}</option>
                  {routeOptions.filter((opt) => opt.value !== primaryValue).map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}

        <div className="gateway-agent-list">
          <div className="gateway-agent-row" data-agent="agentrecall">
            <div className="gateway-agent-info">
              <span className="gateway-builtin-icon" aria-hidden="true">
                <Sparkles size={13} />
              </span>
              <div className="gateway-agent-copy">
                <div className="gateway-agent-title-row">
                  <strong>{l("AgentRecall Built-in AI", "AgentRecall 内置功能")}</strong>
                  <Badge tone="accent">{l("Built-in", "内置")}</Badge>
                </div>
                <span className="gateway-agent-summary">
                  {l(
                    "Memory cards, AI session summaries, AI search & Skill discovery",
                    "Memory 经验卡、AI 会话摘要、AI 找会话、Skill 探索",
                  )}
                </span>
              </div>
            </div>
            <div className="gateway-agent-controls">
              {routeOptions.length > 0 && onSetAgentRecallModel ? (
                <select
                  aria-label={l("AgentRecall Built-in AI model", "AgentRecall 内置功能使用的模型")}
                  className="gateway-route-select"
                  disabled={busy}
                  value={encodeRoute(snapshot.config.agentRecallModel ?? null)}
                  onChange={(event) => void onSetAgentRecallModel(decodeRoute(event.target.value))}
                >
                  <option value="">
                    {primaryLabel
                      ? l(`Default (${primaryLabel})`, `跟随默认 (${primaryLabel})`)
                      : l("Follow default", "跟随默认")}
                  </option>
                  {routeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              ) : (
                <span className="gateway-agent-subtle">
                  {hasProviders
                    ? (primaryLabel || l("Using default", "使用默认"))
                    : l("Add a service in step 1", "请先在步骤 1 添加服务")}
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Step 3: Connect Local Agents */}
      <section className="gateway-card">
        <div className="gateway-card-head">
          <div className="gateway-step-title">
            <span className="gateway-step-badge">3</span>
            <div>
              <h4>{l("Connect local agents", "一键接入本机 Agent")}</h4>
              <p className="gateway-card-hint">
                {l(
                  "Click Connect to back up and wire an agent's config to this gateway; restore anytime without losing your original setup.",
                  "点「一键接入」自动备份原配置并接入网关，可随时无损「还原」，并支持给每个 Agent 单独指定模型。",
                )}
              </p>
            </div>
          </div>
        </div>

        <div className="gateway-agent-list">
          {sortedAgents.map((agent) => (
            <div key={agent.agentId} className="gateway-agent-row" data-agent={agent.agentId}>
              <div className="gateway-agent-info">
                <AgentIcon source={AGENT_SOURCE_ICON[agent.agentId]} size={18} />
                <div className="gateway-agent-copy">
                  <div className="gateway-agent-title-row">
                    <strong>{agent.label}</strong>
                    {agent.wired ? (
                      <Badge tone="success">{l("Connected", "已接入")}</Badge>
                    ) : agent.detected ? (
                      <span className="gateway-agent-subtle">{l("Direct", "本机直连")}</span>
                    ) : (
                      <span className="gateway-agent-subtle">{l("Not installed", "未检测到")}</span>
                    )}
                  </div>
                  <span className="gateway-agent-summary" title={agent.configPath}>
                    {agent.currentSummary}
                  </span>
                </div>
              </div>
              <div className="gateway-agent-controls">
                {routeOptions.length > 0 ? (
                  <select
                    aria-label={l(`${agent.label} model`, `${agent.label} 使用的模型`)}
                    className="gateway-route-select"
                    disabled={busy}
                    value={encodeRoute(agent.routeOverride)}
                    onChange={(event) => void onSetAgentModel(agent.agentId, decodeRoute(event.target.value))}
                  >
                    <option value="">
                      {primaryLabel
                        ? l(`Default (${primaryLabel})`, `跟随默认 (${primaryLabel})`)
                        : l("Follow default", "跟随默认")}
                    </option>
                    {routeOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : null}
                {agent.wired ? (
                  <>
                    {agent.hasBackup ? (
                      <Button
                        size="sm"
                        variant="secondary"
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
                      disabled={busy}
                      onClick={() => void onWireAgent(agent.agentId)}
                    >
                      {l("Rewrite", "重写")}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || !hasProviders}
                    title={!hasProviders ? l("Add a model service in step 1 first", "请先在步骤 1 导入或添加模型服务") : undefined}
                    onClick={() => void onWireAgent(agent.agentId)}
                  >
                    {l("Connect", "一键接入")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={copiedId === agent.agentId ? <Check size={13} /> : <Copy size={13} />}
                  title={l("Copy shell env snippet", "复制环境变量命令")}
                  onClick={() => copyText(agent.agentId, agent.snippet)}
                >
                  {copiedId === agent.agentId ? l("Copied", "已复制") : l("Env", "Env")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Collapsible Advanced Panel (port, local token, curl) */}
      <section className="gateway-advanced">
        <button
          type="button"
          className="gateway-advanced-toggle"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((open) => !open)}
        >
          {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Settings2 size={13} />
          <span>{l("Advanced: port, local token & curl", "高级设置：监听端口、本地密钥与 curl 测试")}</span>
          <code className="gateway-endpoint-code">{snapshot.status.baseUrl}</code>
        </button>
        {showAdvanced ? (
          <div className="gateway-advanced-body">
            <div className="gateway-port-row">
              <label className="gateway-inline-field">
                <span>{l("Port", "监听端口")}</span>
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
                {l("Apply", "应用端口")}
              </Button>
              <div className="gateway-card-head-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={copiedId === "curl" ? <Check size={13} /> : <Copy size={13} />}
                  onClick={() => copyText("curl", curlSnippet)}
                >
                  {copiedId === "curl" ? l("Copied curl", "已复制 curl") : l("Copy curl", "复制 curl")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={copiedId === "token" ? <Check size={13} /> : <Copy size={13} />}
                  onClick={() => copyText("token", snapshot.status.localToken)}
                >
                  {copiedId === "token" ? l("Copied token", "已复制密钥") : l("Copy token", "复制本地密钥")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
