import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ArrowLeft, Check, Cpu, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { defaultApiConfig, defaultClaudeApiConfig, type ApiConfig, type ClaudeApiConfig } from "../../../../core/api-config";
import { agentModelLabel } from "../../../../core/agent-model-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { SavedProvider } from "../../../../shared/ipc/providers";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import { Badge, Button, EmptyState, Group, IconButton, IconTile, Notice, PageBody, PageHeader, Row, Section, Segmented } from "../../ui/primitives";
import { AgentModelEditor } from "./agent-model-editor";
import { ClaudeProviderForm } from "./claude-provider-form";
import { CodexProviderForm } from "./codex-provider-form";
import { SummaryProviderForm } from "./summary-provider-form";

/** Settings pages opened from the Provider header instead of the client provider list. */
export type ProviderView = "agent-model" | "summary";

export function ProviderPage({ settings, language, feedback, onSettingsChange, onApplyToCodex, onApplyToClaude, requestedView, onRequestedViewConsumed }: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void | Promise<void>;
  onApplyToCodex: (config: ApiConfig) => Promise<void>;
  onApplyToClaude: (config: ClaudeApiConfig) => Promise<void>;
  /** Opens a header page on behalf of another page, such as Memory asking for the AgentRecall model. */
  requestedView?: ProviderView | null;
  onRequestedViewConsumed?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [target, setTarget] = useState<"codex" | "claude">("codex");
  const [entries, setEntries] = useState<SavedProvider[]>([]);
  const [editor, setEditor] = useState<SavedProvider | null>(null);
  const [name, setName] = useState("");
  const [view, setView] = useState<ProviderView | null>(requestedView ?? null);
  const [summaryDraft, setSummaryDraft] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<SettingsFeedback>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!requestedView) return;
    setView(requestedView);
    setNotice(null);
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
    setCurrent(l("Reading client configuration…", "正在读取客户端配置…"));
    const read = target === "codex"
      ? window.sessionSearch.getCodexConfig({ configDir: settings?.apiConfig.customConfigDir || undefined }).then((snapshot) =>
        snapshot.exists ? `${snapshot.activeProvider?.name || snapshot.activeProviderId} · ${snapshot.activeModel || l("Default model", "默认模型")}` : l("No local configuration", "尚无本地配置"))
      : window.sessionSearch.getClaudeConfig({ configDir: settings?.claudeApiConfig.customConfigDir || undefined }).then((snapshot) =>
        snapshot.exists ? `${snapshot.route.customBaseUrl || l("Official account", "官方账号")} · ${snapshot.route.customModel || l("Default model", "默认模型")}` : l("No local configuration", "尚无本地配置"));
    read.then((value) => { if (!cancelled) setCurrent(value); }).catch(() => {
      if (!cancelled) setCurrent(l("Unable to read client configuration", "无法读取客户端配置"));
    });
    return () => { cancelled = true; };
  }, [target, settings?.apiConfig, settings?.claudeApiConfig, refresh, language]);

  async function run(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try { await operation(); }
    catch (error) { if (alive.current) setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) }); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }

  function add() {
    const item: SavedProvider = target === "codex"
      ? { id: crypto.randomUUID(), target, name: "", config: { ...defaultApiConfig, activeProvider: "custom", customProviderId: "custom", customProviderName: "", customBaseUrl: "", customModel: "", customApiKey: "" } }
      : { id: crypto.randomUUID(), target, name: "", config: { ...defaultClaudeApiConfig, activeProvider: "custom", customProviderId: "custom", customProviderName: "", customBaseUrl: "", customModel: "", customApiKey: "" } };
    setName(""); setEditor(item); setNotice(null);
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
      setEntries(items); setEditor(null); setAppliedId(null);
      setNotice({ kind: "success", message: l("Provider saved. Enable it when you are ready to use it.", "服务商已保存，点击启用即可应用到客户端。") });
    });
  }

  async function enable(item?: SavedProvider) {
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

  const client = target === "codex" ? "Codex" : "Claude Code";
  const editorSettings = editor && settings ? { ...settings, ...(editor.target === "codex" ? { apiConfig: editor.config } : { claudeApiConfig: editor.config }) } : settings;
  const editorFeedback: SettingsFeedback = busy ? { kind: "running", message: l("Saving…", "正在保存…") } : notice;
  const back = (label: string, onClick: () => void) => <Button variant="ghost" size="sm" icon={<ArrowLeft />} disabled={busy} onClick={onClick}>{label}</Button>;
  const status = notice ? <Notice kind={notice.kind}>{notice.message}</Notice> : null;

  if (view === "agent-model") return <section className="provider-page provider-library" data-page="providers">
    <PageHeader title={l("AgentRecall model", "AgentRecall 模型")} description={l("Experience cards and AI Skill exploration send their prompts straight to this model. The calls use its API quota and do not create agent sessions.", "经验卡和 AI Skill 探索直接把请求发给这个模型，会消耗它的 API 用量，不会产生 Agent 会话。")} actions={back(l("Back to providers", "返回服务商"), () => setView(null))} />
    <PageBody><AgentModelEditor settings={settings} language={language} feedback={feedback} onSettingsChange={onSettingsChange} /></PageBody>
  </section>;

  if (view === "summary") return <section className="provider-page provider-library" data-page="providers">
    <PageHeader title={l("AI summary & search", "AI 摘要与搜索")} description={l("Session summaries, AI find and long-session compression use this route.", "会话摘要、AI 查找和长会话压缩使用这里的服务。")} actions={back(l("Back to providers", "返回服务商"), () => setView(null))} />
    <PageBody>
      <label className="provider-summary-pick"><span>{l("Reuse a saved API connection", "复用已保存的 API 服务")}</span>
        <select disabled={busy} defaultValue="" onChange={(event) => { const id = event.target.value; if (!id) return; void run(async () => {
          const item = await window.sessionSearch.readSavedProvider(id);
          if (item.target !== "codex" || !settings || !alive.current) return;
          setSummaryDraft({ ...settings, summarySource: "custom", summaryApiConfigMode: "custom", summaryApiConfig: item.config });
        }); }}><option value="">{l("Choose a connection…", "选择一套服务配置…")}</option>{entries.filter((item) => item.target === "codex" && item.config.activeProvider === "custom").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      </label>
      {status}
      <SummaryProviderForm settings={summaryDraft ?? settings} language={language} feedback={feedback} onSettingsChange={onSettingsChange} />
    </PageBody>
  </section>;

  if (editor) return <section className="provider-page provider-library" data-page="providers">
    <PageHeader title={`${entries.some((item) => item.id === editor.id) ? l("Edit provider", "编辑服务商") : l("Add provider", "添加服务商")} · ${client}`} actions={back(l("Back", "返回"), () => { setEditor(null); setNotice(null); })} />
    <PageBody>
      <div className="provider-editor-heading">
        <label><span>{l("Name", "名称")}</span><input autoFocus maxLength={100} disabled={busy} value={name} placeholder={l("e.g. Work account", "例如：公司账号、个人备用")} onChange={(event) => setName(event.target.value)} /></label>
      </div>
      {editor.target === "codex"
        ? <CodexProviderForm key={editor.id} settings={editorSettings} language={language} feedback={editorFeedback} onSettingsChange={save} />
        : <ClaudeProviderForm key={editor.id} settings={editorSettings} language={language} feedback={editorFeedback} onSettingsChange={save} />}
    </PageBody>
  </section>;

  const agentModel = agentModelLabel(settings?.agentModel);
  const summary = settings?.summarySource === "claude" ? l("Uses the Claude Code configuration", "使用 Claude Code 的配置")
    : settings?.summarySource === "custom" ? [settings.summaryApiConfig.customBaseUrl, settings.summaryApiConfig.customModel].filter(Boolean).join(" · ") || l("Custom endpoint", "自定义接口")
    : l("Uses the Codex configuration", "使用 Codex 的配置");
  const saved = entries.filter((item) => item.target === target);
  const applied = (id: string) => appliedId === id ? <Badge tone="success"><Check />{l("Applied", "已写入")}</Badge> : null;
  return <section className="provider-page provider-library" data-page="providers">
    <PageHeader title="Provider" description={l("Choose the services your coding agents and AgentRecall use.", "管理编码 Agent 和 AgentRecall 自己使用的模型服务。")} />
    <PageBody>
      <Section title={l("Used by AgentRecall", "AgentRecall 自己使用")} description={l("These calls do not change your clients' configuration.", "这些调用不会改动客户端配置。")}>
        <Group>
          <Row icon={<IconTile><Cpu size={15} /></IconTile>} label={l("AgentRecall model", "AgentRecall 模型")} disabled={busy} onClick={() => { setView("agent-model"); setNotice(null); }}
            title={l("AgentRecall model", "AgentRecall 模型")}
            description={agentModel ?? l("Not set up · used by experience cards and AI Skill exploration", "尚未设置 · 经验卡和 AI 探索 Skill 使用")}
            trailing={agentModel ? null : <Badge tone="warning">{l("Not set up", "未设置")}</Badge>} />
          <Row icon={<IconTile><SlidersHorizontal size={15} /></IconTile>} label={l("AI summary & search", "AI 摘要与搜索")} disabled={busy} onClick={() => { setSummaryDraft(null); setView("summary"); setNotice(null); }}
            title={l("AI summary & search", "AI 摘要与搜索")} description={summary} />
        </Group>
      </Section>
      <Section title={l("Client services", "客户端服务")} description={l("Save several connections and write one into the client when you need it.", "保存多套服务，需要时一键写入客户端。")}
        actions={<>
          <Segmented label={l("Client", "客户端")} disabled={busy} value={target} options={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }]} onChange={(value) => { setTarget(value); setRemoveId(null); setNotice(null); }} />
          <Button variant="primary" icon={<Plus />} disabled={!loaded || !settings || busy} onClick={add}>{l("Add provider", "添加服务商")}</Button>
        </>}>
        <Group>
          <Row icon={<span className="provider-current-dot" aria-hidden="true" />} title={current} description={l(`Currently in ${client}`, `${client} 当前配置`)} />
          <Row icon={<IconTile>{target === "codex" ? "O" : "A"}</IconTile>} title={l("Official account", "官方账号")} description={l(`Use the account signed in to ${client}`, `使用 ${client} 已登录的账号`)}
            trailing={<>{applied(`official-${target}`)}<Button size="sm" disabled={busy || !settings || !loaded} onClick={() => void enable()}>{l("Enable", "启用")}</Button></>} />
          {saved.map((item) => <Row key={item.id} icon={<IconTile>{item.name.slice(0, 1).toUpperCase()}</IconTile>} title={item.name}
            description={[item.config.activeProvider === "official" ? l("Official account", "官方账号") : item.config.customBaseUrl || l("No address", "尚未填写地址"), item.config.customModel || l("Default model", "默认模型"), item.config.customConfigDir].filter(Boolean).join(" · ")}
            trailing={removeId === item.id ? <>
              <span className="provider-remove-question">{l("Remove? Client settings stay unchanged.", "删除这套配置？客户端配置不受影响。")}</span>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(async () => { const items = await window.sessionSearch.removeSavedProvider(item.id); if (alive.current) { setEntries(items); setRemoveId(null); } })}>{l("Confirm removal", "确认删除")}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoveId(null)}>{l("Cancel", "取消")}</Button>
            </> : <>
              {applied(item.id)}
              <Button size="sm" disabled={busy} onClick={() => void enable(item)}>{l("Enable", "启用")}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { const value = await window.sessionSearch.readSavedProvider(item.id); if (alive.current) { setEditor(value); setName(value.name); } })}>{l("Edit", "编辑")}</Button>
              <IconButton size="sm" label={`${l("Remove", "删除")} ${item.name}`} icon={<Trash2 />} disabled={busy} onClick={() => setRemoveId(item.id)} />
            </>} />)}
          {loaded && !saved.length ? <EmptyState title={l("No saved services yet", "还没有保存的服务")} description={l("Save work, personal and backup connections separately, then switch without filling in the form again.", "公司、个人、备用配置分别保存，切换时不用重新填写。")} /> : null}
        </Group>
        {!loaded ? <Button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>{l("Reload provider list", "重新加载服务商列表")}</Button> : null}
      </Section>
      {status}
      {busy ? <Notice kind="running">{l("Updating…", "正在处理…")}</Notice> : null}
    </PageBody>
  </section>;
}
