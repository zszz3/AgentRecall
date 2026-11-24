import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { defaultApiConfig, defaultClaudeApiConfig, type ApiConfig, type ClaudeApiConfig } from "../../../../core/api-config";
import { agentModelLabel, type AgentModelImports } from "../../../../core/agent-model-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { SavedProvider } from "../../../../shared/ipc/providers";
import type {
  GatewayAgentId,
  GatewayProviderProtocol,
  GatewayRouteTarget,
  GatewaySnapshot,
} from "../../../../shared/ipc/model-gateway";
import type { SettingsFeedback } from "../../app-types";
import { ResizableSplit } from "../../components/resizable-split";
import { localize, type LanguageMode } from "../../language";
import { CatalogDetail, CatalogGroup, CatalogItem, CatalogPage } from "../../ui/catalog";
import { MenuButton } from "../../ui/menu";
import { Badge, Button, buttonClass, Notice } from "../../ui/primitives";
import { AgentModelEditor } from "./agent-model-editor";
import { ClaudeProviderForm } from "./claude-provider-form";
import { CodexProviderForm } from "./codex-provider-form";
import { GatewayPanel, type GatewaySectionView } from "./gateway-panel";
import { SummaryProviderForm } from "./summary-provider-form";

/** Entries another page can ask the Gateway / Provider page to open. */
export type ProviderView = "agent-model" | "summary" | GatewaySectionView;
type Client = "codex" | "claude";
/** What the detail pane shows: local gateway, AgentRecall's own routes, a client's official account, a saved service or a new one. */
type Selection = ProviderView | `official:${Client}` | `saved:${string}` | "new";

const CLIENT_NAMES: Record<Client, string> = { codex: "Codex", claude: "Claude Code" };

export function ProviderPage({ settings, language, feedback, onSettingsChange, onApplyToCodex, onApplyToClaude, requestedView, onRequestedViewConsumed }: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void | Promise<void>;
  onApplyToCodex: (config: ApiConfig) => Promise<void>;
  onApplyToClaude: (config: ClaudeApiConfig) => Promise<void>;
  /** Opens an entry on behalf of another page, such as Memory asking for the AgentRecall model. */
  requestedView?: ProviderView | null;
  onRequestedViewConsumed?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [entries, setEntries] = useState<SavedProvider[]>([]);
  const [selection, setSelection] = useState<Selection>(requestedView ?? "gateway-overview");
  const [editor, setEditor] = useState<SavedProvider | null>(null);
  const [name, setName] = useState("");
  const [summaryDraft, setSummaryDraft] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<SettingsFeedback>(null);
  const [removing, setRemoving] = useState(false);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [current, setCurrent] = useState<Record<Client, string>>({ codex: "", claude: "" });
  const [refresh, setRefresh] = useState(0);
  const [gatewaySnapshot, setGatewaySnapshot] = useState<GatewaySnapshot | null>(null);
  const [gatewayImports, setGatewayImports] = useState<AgentModelImports | null>(null);
  const [gatewayFeedback, setGatewayFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    if (!requestedView) return;
    choose(requestedView);
    onRequestedViewConsumed?.();
  }, [requestedView]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    window.sessionSearch.listSavedProviders().then((items) => {
      if (!cancelled) { setEntries(items); setLoaded(true); }
    }).catch((error: unknown) => {
      if (!cancelled) setNotice({ kind: "error", message: String(error) });
    });
    return () => { cancelled = true; alive.current = false; };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void window.sessionSearch.getGatewaySnapshot?.().then((snap) => {
      if (!cancelled) setGatewaySnapshot(snap);
    }).catch(() => undefined);
    void window.sessionSearch.listAgentModelImports?.().then((scanned) => {
      if (!cancelled) setGatewayImports(scanned);
    }).catch(() => undefined);
    const offGateway = window.sessionSearch.onGatewaySnapshot?.((snap) => {
      if (!cancelled) setGatewaySnapshot(snap);
    }) ?? (() => undefined);
    return () => {
      cancelled = true;
      offGateway();
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const unreadable = l("Unable to read client configuration", "无法读取客户端配置");
    const codex = window.sessionSearch.getCodexConfig({ configDir: settings?.apiConfig.customConfigDir || undefined }).then((snapshot) =>
      snapshot.exists ? `${snapshot.activeProvider?.name || snapshot.activeProviderId} · ${snapshot.activeModel || l("Default model", "默认模型")}` : l("No local configuration", "尚无本地配置"), () => unreadable);
    const claude = window.sessionSearch.getClaudeConfig({ configDir: settings?.claudeApiConfig.customConfigDir || undefined }).then((snapshot) =>
      snapshot.exists ? `${snapshot.route.customBaseUrl || l("Official account", "官方账号")} · ${snapshot.route.customModel || l("Default model", "默认模型")}` : l("No local configuration", "尚无本地配置"), () => unreadable);
    void Promise.all([codex, claude]).then(([codexText, claudeText]) => { if (!cancelled) setCurrent({ codex: codexText, claude: claudeText }); });
    return () => { cancelled = true; };
  }, [settings?.apiConfig, settings?.claudeApiConfig, refresh, language]);

  async function run(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    setGatewayFeedback(null);
    try { await operation(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (alive.current) {
        setNotice({ kind: "error", message });
        setGatewayFeedback({ kind: "error", message });
      }
    }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }

  function choose(next: Selection, keepNotice = false) {
    if (busyRef.current) return;
    setSelection(next);
    setRemoving(false);
    if (!keepNotice) { setNotice(null); setGatewayFeedback(null); }
    if (next === "summary") setSummaryDraft(null);
    if (!next.startsWith("saved:")) { if (next !== "new") setEditor(null); return; }
    const id = next.slice("saved:".length);
    setEditor(null);
    void run(async () => {
      const value = await window.sessionSearch.readSavedProvider(id);
      if (alive.current) { setEditor(value); setName(value.name); }
    });
  }

  function add(target: Client) {
    const item: SavedProvider = target === "codex"
      ? { id: crypto.randomUUID(), target, name: "", config: { ...defaultApiConfig, activeProvider: "custom", customProviderId: "custom", customProviderName: "", customBaseUrl: "", customModel: "", customApiKey: "" } }
      : { id: crypto.randomUUID(), target, name: "", config: { ...defaultClaudeApiConfig, activeProvider: "custom", customProviderId: "custom", customProviderName: "", customBaseUrl: "", customModel: "", customApiKey: "" } };
    setSelection("new"); setRemoving(false); setName(""); setEditor(item); setNotice(null);
  }

  function save(update: AppSettingsUpdate) {
    if (!editor) return;
    const trimmed = name.trim();
    if (!trimmed) { setNotice({ kind: "error", message: l("Name this provider before saving.", "请先为这套服务配置命名。") }); return; }
    const item: SavedProvider = editor.target === "codex"
      ? { ...editor, name: trimmed, config: { ...editor.config, ...update.apiConfig, customProviderName: trimmed } }
      : { ...editor, name: trimmed, config: { ...editor.config, ...update.claudeApiConfig, customProviderName: trimmed } };
    void run(async () => {
      const items = await window.sessionSearch.saveProvider(item);
      if (!alive.current) return;
      setEntries(items); setEditor(item); setSelection(`saved:${item.id}`); setAppliedId(null);
      setNotice({ kind: "success", message: l("Provider saved. Enable it when you are ready to use it.", "服务商已保存，点击启用即可应用到客户端。") });
    });
  }

  async function enable(target: Client, item?: SavedProvider) {
    await run(async () => {
      const provider = item ? await window.sessionSearch.readSavedProvider(item.id) : null;
      if (provider?.config.activeProvider === "custom" && !provider.config.customApiKey.trim()) throw new Error(l("Edit this provider and enter its API key before enabling it.", "请先编辑这套服务配置并填写 API Key，再启用。"));
      if (provider?.target === "claude") await onApplyToClaude(provider.config);
      else if (provider?.target === "codex") await onApplyToCodex(provider.config);
      else if (target === "claude") await onApplyToClaude({ ...defaultClaudeApiConfig, customConfigDir: settings?.claudeApiConfig.customConfigDir || "" });
      else await onApplyToCodex({ ...defaultApiConfig, customConfigDir: settings?.apiConfig.customConfigDir || "" });
      if (!alive.current) return;
      setAppliedId(item?.id || `official-${target}`);
      setRefresh((value) => value + 1);
      setNotice({ kind: "success", message: l("Client configuration updated. Start a new client session to use it.", "客户端配置已更新，请在客户端新建会话使用。") });
    });
  }

  async function remove(item: SavedProvider) {
    await run(async () => {
      const items = await window.sessionSearch.removeSavedProvider(item.id);
      if (!alive.current) return;
      setEntries(items); setEditor(null); setRemoving(false); setSelection("agent-model");
    });
  }

  const handleSetGatewayEnabled = async (enabled: boolean, port?: number) => {
    await run(async () => {
      const next = await window.sessionSearch.setGatewayEnabled(enabled, port);
      if (!alive.current) return;
      setGatewaySnapshot(next);
      setGatewayFeedback({
        kind: "success",
        message: next.status.running
          ? l(`Gateway listening on ${next.status.baseUrl}`, `本地网关已启动：${next.status.baseUrl}`)
          : l("Local model gateway stopped.", "本地模型网关已停止。"),
      });
    });
  };

  const handleSaveGatewayProvider = async (input: {
    id?: string;
    name: string;
    protocol: GatewayProviderProtocol;
    baseUrl: string;
    defaultModel: string;
    models?: string[];
    enabled?: boolean;
    apiKey?: string;
    importId?: string;
  }) => {
    await run(async () => {
      const next = await window.sessionSearch.saveGatewayProvider(input);
      if (!alive.current) return;
      setGatewaySnapshot(next);
      setGatewayFeedback({ kind: "success", message: l("Gateway upstream provider saved.", "上游 Provider 已保存。") });
    });
  };

  const handleTestGatewayProvider = async (providerId: string) => {
    return window.sessionSearch.testGatewayProvider(providerId);
  };

  const handleRemoveGatewayProvider = async (providerId: string) => {
    await run(async () => {
      const next = await window.sessionSearch.removeGatewayProvider(providerId);
      if (!alive.current) return;
      setGatewaySnapshot(next);
      setGatewayFeedback({ kind: "success", message: l("Gateway provider removed.", "上游 Provider 已删除。") });
    });
  };

  const handleSetGatewayRouting = async (primary: GatewayRouteTarget | null, fallbacks: GatewayRouteTarget[]) => {
    await run(async () => {
      const next = await window.sessionSearch.setGatewayRouting(primary, fallbacks);
      if (!alive.current) return;
      setGatewaySnapshot(next);
      setGatewayFeedback({ kind: "success", message: l("Gateway routing updated.", "路由规则已更新。") });
    });
  };

  const handleSetGatewayAgentModel = async (agentId: GatewayAgentId, target: GatewayRouteTarget | null) => {
    await run(async () => {
      const next = await window.sessionSearch.setGatewayAgentModel(agentId, target);
      if (!alive.current) return;
      setGatewaySnapshot(next);
    });
  };

  const handleWireGatewayAgent = async (agentId: GatewayAgentId) => {
    await run(async () => {
      // Automatically turn on the local gateway when connecting an agent so one click just works.
      if (gatewaySnapshot && !gatewaySnapshot.status.running) {
        const started = await window.sessionSearch.setGatewayEnabled(true, gatewaySnapshot.config.port);
        if (!alive.current) return;
        setGatewaySnapshot(started);
      }
      const result = await window.sessionSearch.wireGatewayAgent(agentId);
      if (!alive.current) return;
      setGatewaySnapshot(result.snapshot);
      setRefresh((value) => value + 1);
      setGatewayFeedback({ kind: "success", message: result.message });
    });
  };

  const handleRestoreGatewayAgent = async (agentId: GatewayAgentId) => {
    await run(async () => {
      const result = await window.sessionSearch.restoreGatewayAgent(agentId);
      if (!alive.current) return;
      setGatewaySnapshot(result.snapshot);
      setRefresh((value) => value + 1);
      setGatewayFeedback({ kind: "success", message: result.message });
    });
  };

  const handleClearGatewayRequests = async () => {
    await run(async () => {
      const next = await window.sessionSearch.clearGatewayRequests();
      if (!alive.current) return;
      setGatewaySnapshot(next);
    });
  };

  const agentModel = agentModelLabel(settings?.agentModel);
  const summary = settings?.summarySource === "claude" ? l("Uses the Claude Code configuration", "使用 Claude Code 的配置")
    : settings?.summarySource === "custom" ? [settings.summaryApiConfig.customBaseUrl, settings.summaryApiConfig.customModel].filter(Boolean).join(" · ") || l("Custom endpoint", "自定义接口")
    : l("Uses the Codex configuration", "使用 Codex 的配置");
  const describe = (item: SavedProvider) => [item.config.activeProvider === "official" ? l("Official account", "官方账号") : item.config.customBaseUrl || l("No address", "尚未填写地址"), item.config.customModel || l("Default model", "默认模型")].join(" · ");
  const applied = (id: string) => appliedId === id ? <Badge tone="success"><Check size={12} />{l("Applied", "已写入")}</Badge> : undefined;
  const status = notice ? <Notice kind={notice.kind}>{notice.message}</Notice> : busy ? <Notice kind="running">{l("Updating…", "正在处理…")}</Notice> : null;
  const item = (key: Selection, title: string, meta: string, trailing?: ReactElement) =>
    <CatalogItem key={key} title={title} meta={meta} trailing={trailing} selected={selection === key} onSelect={() => choose(key)} />;

  const wiredCount = gatewaySnapshot?.agents.filter((agent) => agent.wired).length ?? 0;
  const providerCount = gatewaySnapshot?.config.providers.length ?? 0;
  const requestCount = gatewaySnapshot?.requests.length ?? 0;

  const list = <div className="catalog-list" aria-label={l("Gateway & Providers", "网关与服务商")}>
    <CatalogGroup
      title={l("Local Gateway", "本地模型网关")}
      hint={gatewaySnapshot?.status.running
        ? l(`Listening on ${gatewaySnapshot.status.baseUrl}`, `监听中：${gatewaySnapshot.status.baseUrl}`)
        : l("Unified local model gateway and one-click agent setup.", "统一管理模型服务并一键写入各 Agent 配置。")}
    >
      {item(
        "gateway-overview",
        l("Gateway setup", "模型网关"),
        wiredCount > 0
          ? l(`${providerCount} service(s) · ${wiredCount} connected`, `${providerCount} 个服务 · 已接入 ${wiredCount} 个 Agent`)
          : providerCount > 0
            ? l(`${providerCount} service(s) ready`, `已配置 ${providerCount} 个服务`)
            : l("Add services & connect agents", "添加模型并一键接入 Agent"),
        <Badge tone={gatewaySnapshot?.status.running ? "success" : "neutral"}>
          {gatewaySnapshot?.status.running ? l("Running", "运行中") : l("Off", "未开启")}
        </Badge>,
      )}
      {item(
        "gateway-requests",
        l("Request log", "请求日志"),
        requestCount > 0 ? l(`${requestCount} recent call(s)`, `近期 ${requestCount} 次调用`) : l("No requests yet", "暂无记录"),
      )}
    </CatalogGroup>
    <CatalogGroup title={l("Used by AgentRecall", "AgentRecall 自己使用")} hint={l("These calls do not change your clients' configuration.", "这些调用不会改动客户端配置。")}>
      {item("agent-model", l("AgentRecall model", "AgentRecall 模型"), agentModel ?? l("Not set up", "尚未设置"), agentModel ? undefined : <Badge tone="warning">{l("Not set up", "未设置")}</Badge>)}
      {item("summary", l("AI summary & search", "AI 摘要与搜索"), summary)}
    </CatalogGroup>
    {(["codex", "claude"] as const).map((client) => <CatalogGroup key={client} title={CLIENT_NAMES[client]} hint={current[client] ? l(`Now: ${current[client]}`, `当前：${current[client]}`) : undefined}>
      {item(`official:${client}`, l("Official account", "官方账号"), l(`The account signed in to ${CLIENT_NAMES[client]}`, `使用 ${CLIENT_NAMES[client]} 已登录的账号`), applied(`official-${client}`))}
      {entries.filter((entry) => entry.target === client).map((entry) => item(`saved:${entry.id}`, entry.name, describe(entry), applied(entry.id)))}
    </CatalogGroup>)}
    {!loaded ? <Button size="sm" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>{l("Reload provider list", "重新加载服务商列表")}</Button> : null}
  </div>;

  let detail: ReactNode;
  if (selection === "gateway-overview" || selection === "gateway-requests") {
    detail = (
      <GatewayPanel
        view={selection}
        snapshot={gatewaySnapshot}
        imports={gatewayImports}
        language={language}
        busy={busy}
        feedback={gatewayFeedback}
        onSetEnabled={handleSetGatewayEnabled}
        onSaveProvider={handleSaveGatewayProvider}
        onRemoveProvider={handleRemoveGatewayProvider}
        onTestProvider={handleTestGatewayProvider}
        onSetRouting={handleSetGatewayRouting}
        onSetAgentModel={handleSetGatewayAgentModel}
        onWireAgent={handleWireGatewayAgent}
        onRestoreAgent={handleRestoreGatewayAgent}
        onClearRequests={handleClearGatewayRequests}
      />
    );
  } else if (selection === "agent-model") {
    detail = <CatalogDetail title={l("AgentRecall model", "AgentRecall 模型")} subtitle={l("Experience cards and AI Skill exploration send their prompts straight to this model. The calls use its API quota and do not create agent sessions.", "经验卡和 AI Skill 探索直接把请求发给这个模型，会消耗它的 API 用量，不会产生 Agent 会话。")}>
      <AgentModelEditor settings={settings} language={language} feedback={feedback} onSettingsChange={onSettingsChange} />
    </CatalogDetail>;
  } else if (selection === "summary") {
    detail = <CatalogDetail title={l("AI summary & search", "AI 摘要与搜索")} subtitle={l("Session summaries, AI find and long-session compression use this route.", "会话摘要、AI 查找和长会话压缩使用这里的服务。")}>
      <label className="provider-summary-pick"><span>{l("Reuse a saved API connection", "复用已保存的 API 服务")}</span>
        <select disabled={busy} defaultValue="" onChange={(event) => { const id = event.target.value; if (!id) return; void run(async () => {
          const saved = await window.sessionSearch.readSavedProvider(id);
          if (saved.target !== "codex" || !settings || !alive.current) return;
          setSummaryDraft({ ...settings, summarySource: "custom", summaryApiConfigMode: "custom", summaryApiConfig: saved.config });
        }); }}><option value="">{l("Choose a connection…", "选择一套服务配置…")}</option>{entries.filter((entry) => entry.target === "codex" && entry.config.activeProvider === "custom").map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
      </label>
      {status}
      <SummaryProviderForm settings={summaryDraft ?? settings} language={language} feedback={feedback} onSettingsChange={onSettingsChange} />
    </CatalogDetail>;
  } else if (selection.startsWith("official:")) {
    const client = selection.slice("official:".length) as Client;
    detail = <CatalogDetail
      title={l(`Official account · ${CLIENT_NAMES[client]}`, `官方账号 · ${CLIENT_NAMES[client]}`)}
      subtitle={l(`Write the account signed in to ${CLIENT_NAMES[client]} back into its configuration.`, `把 ${CLIENT_NAMES[client]} 的配置改回使用已登录的账号。`)}
      facts={[{ label: l("Now", "当前配置"), value: current[client] || "—" }]}
      actions={<Button size="sm" variant="primary" disabled={busy || !settings || !loaded} onClick={() => void enable(client)}>{l("Enable", "启用")}</Button>}
    >{status}</CatalogDetail>;
  } else if (editor) {
    const isNew = !entries.some((entry) => entry.id === editor.id);
    const client = editor.target;
    const editorSettings = settings ? { ...settings, ...(client === "codex" ? { apiConfig: editor.config } : { claudeApiConfig: editor.config }) } : settings;
    const editorFeedback: SettingsFeedback = busy ? { kind: "running", message: l("Saving…", "正在保存…") } : notice;
    detail = <CatalogDetail
      title={isNew ? l(`New ${CLIENT_NAMES[client]} service`, `新的 ${CLIENT_NAMES[client]} 服务`) : editor.name}
      subtitle={l(`Saved services are written into ${CLIENT_NAMES[client]} only when you enable them.`, `保存的服务只有点「启用」后才会写入 ${CLIENT_NAMES[client]}。`)}
      facts={isNew ? undefined : [{ label: l("Client", "客户端"), value: CLIENT_NAMES[client] }, { label: l("Route", "服务"), value: describe(editor) }]}
      actions={isNew ? undefined : <>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void enable(client, editor)}>{l("Enable", "启用")}</Button>
        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={busy} onClick={() => setRemoving(true)}>{l("Remove", "删除")}</Button>
      </>}
    >
      {removing ? <div className="catalog-confirm" role="group" aria-label={l("Confirm removal", "确认删除")}>
        <span>{l("Remove this saved service? Client settings stay unchanged.", "删除这套配置？客户端配置不受影响。")}</span>
        <Button size="sm" onClick={() => setRemoving(false)}>{l("Cancel", "取消")}</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(editor)}>{l("Confirm removal", "确认删除")}</Button>
      </div> : null}
      {selection !== "new" ? status : null}
      <div className="provider-editor-heading">
        <label><span>{l("Name", "名称")}</span><input maxLength={100} disabled={busy} value={name} placeholder={l("e.g. Work account", "例如：公司账号、个人备用")} onChange={(event) => setName(event.target.value)} /></label>
      </div>
      {client === "codex"
        ? <CodexProviderForm key={editor.id} settings={editorSettings} language={language} feedback={editorFeedback} onSettingsChange={save} />
        : <ClaudeProviderForm key={editor.id} settings={editorSettings} language={language} feedback={editorFeedback} onSettingsChange={save} />}
    </CatalogDetail>;
  } else {
    detail = <CatalogDetail title={l("Loading…", "正在读取…")}>{status}</CatalogDetail>;
  }

  return <CatalogPage
    title={l("Gateway", "网关")}
    meta={l("Local model gateway, one-click agent wiring, and direct provider settings", "本机模型网关、一键写入 Agent 配置与直连模型服务")}
    actions={<MenuButton label={l("Add provider", "添加服务商")} text={l("Add provider", "添加服务商")} icon={<Plus size={14} />} className={buttonClass("primary", "sm")} disabled={!loaded || !settings || busy}
      items={[
        { key: "gateway", label: l("Gateway model service", "网关模型服务"), onSelect: () => choose("gateway-overview") },
        ...(["codex", "claude"] as const).map((client) => ({ key: client, label: CLIENT_NAMES[client], onSelect: () => add(client) })),
      ]} />}
  >
    <ResizableSplit className="catalog-split provider-page" label={l("Resize the list", "调整列表宽度")} storageKey="agent-recall-provider-pane.v2" initialWidth={216} minWidth={180} maxWidth={320}>
      {list}
      <div className="catalog-detail-pane" data-page="providers">{detail}</div>
    </ResizableSplit>
  </CatalogPage>;
}
