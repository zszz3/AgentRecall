import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ArrowLeft, Check, ChevronRight, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { defaultApiConfig, defaultClaudeApiConfig, type ApiConfig, type ClaudeApiConfig } from "../../../../core/api-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { SavedProvider } from "../../../../shared/ipc/providers";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import { ProviderEditor } from "./provider-editor";

export function ProviderPage({ settings, language, feedback, onSettingsChange, onApplyToCodex, onApplyToClaude }: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onApplyToCodex: (config: ApiConfig) => Promise<void>;
  onApplyToClaude: (config: ClaudeApiConfig) => Promise<void>;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [target, setTarget] = useState<"codex" | "claude">("codex");
  const [entries, setEntries] = useState<SavedProvider[]>([]);
  const [editor, setEditor] = useState<SavedProvider | null>(null);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState(false);
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
  return <section className="provider-page provider-library" data-page="providers">
    <header className="app-page-head provider-library-head">
      <div><h2>{l("Providers", "服务商")}</h2><p>{l("Keep your connections ready. Choose one when you need it.", "保存常用服务，按需切换。")}</p></div>
      <button className="provider-text-action" disabled={busy} onClick={() => { setSummaryDraft(null); setSummary(true); setNotice(null); }}><SlidersHorizontal size={15} />{l("AI summary & search", "AI 摘要与搜索")}</button>
    </header>
    {summary ? <>
      <button className="provider-back" disabled={busy} onClick={() => setSummary(false)}><ArrowLeft size={16} />{l("Back to providers", "返回服务商")}</button>
      <label className="provider-summary-pick">{l("Reuse a saved API connection", "复用已保存的 API 服务")}
        <select disabled={busy} defaultValue="" onChange={(event) => { const id = event.target.value; if (!id) return; void run(async () => {
          const item = await window.sessionSearch.readSavedProvider(id);
          if (item.target !== "codex" || !settings || !alive.current) return;
          setSummaryDraft({ ...settings, summarySource: "custom", summaryApiConfigMode: "custom", summaryApiConfig: item.config });
        }); }}><option value="">{l("Choose a connection…", "选择一套服务配置…")}</option>{entries.filter((item) => item.target === "codex" && item.config.activeProvider === "custom").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      </label>
      {notice && <div role="status" className={`api-config-status ${notice.kind}`}>{notice.message}</div>}
      <ProviderEditor settings={summaryDraft ?? settings} language={language} feedback={feedback} onSettingsChange={onSettingsChange} onApplyToCodex={onApplyToCodex} onApplyToClaude={onApplyToClaude} target="summary" />
    </> : editor ? <>
      <div className="provider-editor-heading">
        <button className="provider-back" disabled={busy} onClick={() => { setEditor(null); setNotice(null); }}><ArrowLeft size={16} />{l("Back", "返回")}</button>
        <h3>{entries.some((item) => item.id === editor.id) ? l("Edit provider", "编辑服务商") : l("Add provider", "添加服务商")} · {client}</h3>
        <label>{l("Name", "名称")}<input autoFocus maxLength={100} disabled={busy} value={name} placeholder={l("e.g. Work account", "例如：公司账号、个人备用")} onChange={(event) => setName(event.target.value)} /></label>
      </div>
      <ProviderEditor key={editor.id} settings={editorSettings} language={language} feedback={busy ? { kind: "running", message: l("Saving…", "正在保存…") } : notice} onSettingsChange={save} onApplyToCodex={onApplyToCodex} onApplyToClaude={onApplyToClaude} target={editor.target} savedConfiguration />
    </> : <>
      <div className="provider-library-toolbar"><div className="api-target-tabs" role="tablist" aria-label={l("Client", "客户端")}>
        {(["codex", "claude"] as const).map((value) => <button role="tab" aria-selected={target === value} key={value} disabled={busy} className={target === value ? "active" : ""} onClick={() => { setTarget(value); setRemoveId(null); setNotice(null); }}>{value === "codex" ? "Codex" : "Claude Code"}</button>)}
      </div><button className="primary-action" disabled={!loaded || !settings || busy} onClick={add}><Plus size={15} />{l("Add provider", "添加服务商")}</button></div>
      <div className="provider-library-content">
        <div className="provider-current"><span className="provider-current-dot" /><div><span>{l("Client configuration", "客户端当前配置")}</span><strong>{current}</strong></div></div>
        <div className="provider-list">
          <div className="provider-list-row"><div className="provider-avatar">{target === "codex" ? "O" : "A"}</div><div className="provider-row-main"><strong>{l("Official account", "官方账号")}</strong><span>{l("Use the account signed in to", "使用客户端已登录的账号")} {language === "en" ? client : ""}</span></div><button disabled={busy || !settings || !loaded} onClick={() => void enable()}>{appliedId === `official-${target}` ? <><Check size={14} />{l("Applied", "已写入")}</> : l("Enable", "启用")}</button></div>
          {entries.filter((item) => item.target === target).map((item) => <div className="provider-list-row" key={item.id}>
            <div className="provider-avatar">{item.name.slice(0, 1).toUpperCase()}</div><div className="provider-row-main"><strong>{item.name}</strong><span>{item.config.activeProvider === "official" ? l("Official account", "官方账号") : item.config.customBaseUrl || l("No address", "尚未填写地址")}</span><small>{item.config.customModel || l("Default model", "默认模型")}{item.config.customConfigDir ? ` · ${item.config.customConfigDir}` : ""}</small></div>
            {removeId === item.id ? <div className="provider-remove-confirm"><span>{l("Remove saved configuration? Client settings stay unchanged.", "删除这套配置？客户端当前配置将保留。")}</span><button disabled={busy} onClick={() => void run(async () => { const items = await window.sessionSearch.removeSavedProvider(item.id); if (alive.current) { setEntries(items); setRemoveId(null); } })}>{l("Confirm removal", "确认删除")}</button><button disabled={busy} onClick={() => setRemoveId(null)}>{l("Cancel", "取消")}</button></div> : <div className="provider-row-actions">
              <button disabled={busy} onClick={() => void enable(item)}>{appliedId === item.id ? <><Check size={14} />{l("Applied", "已写入")}</> : l("Enable", "启用")}</button>
              <button disabled={busy} onClick={() => void run(async () => { const value = await window.sessionSearch.readSavedProvider(item.id); if (alive.current) { setEditor(value); setName(value.name); } })}>{l("Edit", "编辑")}<ChevronRight size={14} /></button>
              <button className="provider-icon-action" aria-label={`${l("Remove", "删除")} ${item.name}`} disabled={busy} onClick={() => setRemoveId(item.id)}><Trash2 size={14} /></button>
            </div>}
          </div>)}
        </div>
        {loaded && !entries.some((item) => item.target === target) && <div className="provider-empty"><p>{l("Add your first provider", "添加你的第一个服务商")}</p><span>{l("Save multiple connections and switch without filling in the form again.", "公司、个人、备用配置分别保存，切换时不用重新填写。")}</span></div>}
        {!loaded && <button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>{l("Reload provider list", "重新加载服务商列表")}</button>}
        {notice && <div role="status" className={`api-config-status ${notice.kind}`}>{notice.message}</div>}
        {busy && <div role="status" className="api-config-status">{l("Updating…", "正在处理…")}</div>}
      </div>
    </>}
  </section>;
}
