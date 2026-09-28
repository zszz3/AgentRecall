import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { ConfigurationChange } from "@agentrecall/workspace-core";
import type { TeamPayload } from "../../../../shared/ipc/team-workspace";
import { configurationChangeSchema } from "../../../../../../../packages/workspace-core/src/configuration-format";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";

type Preview = Extract<TeamPayload, { kind: "configuration-preview" }>["value"];
type Published = Extract<TeamPayload, { kind: "configuration-published" }>["value"];
type Field = { key: string; value: string; source: "value" | "environment" };
const fields = (values: Record<string, string | { fromEnv: string }>): Field[] => Object.entries(values).map(([key, value]) => ({ key, value: typeof value === "string" ? value : value.fromEnv, source: typeof value === "string" ? "value" : "environment" }));

export function TeamConfigurationEditor({ kind, initial, selection, revision, language, api, onClose, onPublished, onBusy }: {
  kind: ConfigurationChange["kind"]; initial: ConfigurationChange | null; selection: TeamSelection; revision: string; language: LanguageMode; api: TeamWorkspaceApi;
  onClose(): void; onPublished(result: Published): void; onBusy(value: boolean): void;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const title = kind === "instructions" ? l("Shared instructions", "共享指令") : kind === "mcp" ? "MCP" : "Env";
  const scope = { teamId: selection.team.id, repository: selection.team.repository };
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false), running = useRef(false), token = useRef<string | null>(null);
  const [name, setName] = useState(initial?.value.name ?? ""), [id, setId] = useState(() => initial && initial.kind !== "environment" ? initial.value.id : kind === "environment" ? "" : `${kind}-${crypto.randomUUID().slice(0, 8)}`);
  const [targets, setTargets] = useState<Array<"codex" | "claude">>(initial?.value.targets ?? ["codex", "claude"]);
  const [content, setContent] = useState(initial?.kind === "instructions" ? initial.value.content : ""), [value, setValue] = useState(initial?.kind === "environment" ? initial.value.value : "");
  const server = initial?.kind === "mcp" ? initial.value : null;
  const [transport, setTransport] = useState<"http" | "stdio">(server?.transport ?? "http"), [url, setUrl] = useState(server?.transport === "http" ? server.url : "");
  const [command, setCommand] = useState(server?.transport === "stdio" ? server.command : ""), [args, setArgs] = useState(JSON.stringify(server?.transport === "stdio" ? server.args : [], null, 2));
  const [headers, setHeaders] = useState<Field[]>(server?.transport === "http" ? fields(server.headers) : []), [environment, setEnvironment] = useState<Field[]>(server?.transport === "stdio" ? fields(server.env) : []);
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current; element?.showModal();
    element?.querySelector<HTMLInputElement>('input[name="resource-name"]')?.focus();
    return () => {
      alive.current = false; element?.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      if (running.current) void api.request({ action: "cancel-sync" }).catch(() => undefined); // Window-owned work is cancelled on navigation.
      if (token.current) void api.request({ action: "configuration-discard", token: token.current }).catch(() => undefined); // Tokens also expire server-side.
      onBusy(false);
    };
  }, [api, onBusy]);
  function backToEdit() {
    if (token.current) void api.request({ action: "configuration-discard", token: token.current }).catch(() => undefined); // Expiration is the fallback if this window disconnects.
    token.current = null; setPreview(null); setError("");
  }
  async function run(publish: boolean) {
    if (running.current) return;
    running.current = true; setBusy(true); onBusy(true); setError("");
    try {
      let reply;
      if (publish) {
        if (!preview) return;
        reply = await api.request({ action: "configuration-publish", scope, token: preview.token });
      } else {
        const entries = (transport === "http" ? headers : environment).map((field) => ({ ...field, key: field.key.trim() }));
        if (new Set(entries.map(field => field.key.toUpperCase())).size !== entries.length) throw new Error(l("Field names must be unique.", "变量或请求头名称不能重复。"));
        const values = Object.fromEntries(entries.map(field => [field.key, field.source === "environment" ? { fromEnv: transport === "stdio" ? field.key : field.value.trim() } : field.value]));
        let argumentsValue: unknown = [];
        if (kind === "mcp" && transport === "stdio") {
          try { argumentsValue = JSON.parse(args); } catch { throw new Error(l("Arguments must be a JSON array, for example [\"-y\", \"package-name\"].", "启动参数请填写 JSON 数组，例如 [\"-y\", \"package-name\"]。")); }
        }
        const operation = initial ? "update" : "create";
        const draft = kind === "environment" ? { kind, operation, value: { name: name.trim(), value, targets } }
          : kind === "instructions" ? { kind, operation, value: { id: id.trim(), name: name.trim(), content, targets } }
          : { kind, operation, value: { id: id.trim(), name: name.trim(), targets, ...(transport === "http" ? { transport, url: url.trim(), headers: values } : { transport, command: command.trim(), args: argumentsValue, env: values }) } };
        const parsed = configurationChangeSchema.safeParse(draft);
        if (!parsed.success) throw new Error(l("Check the identifier, fields and client selection. Local variable references must be names; STDIO references must match their field names.", "请检查标识、字段格式和客户端选择。本机变量引用应填写变量名；STDIO 引用名需与对应变量名一致。"));
        reply = await api.request({ action: "configuration-preview", scope, revision, change: parsed.data });
      }
      if (!alive.current) {
        if (reply.ok && reply.data.kind === "configuration-preview") void api.request({ action: "configuration-discard", token: reply.data.value.token }).catch(() => undefined); // A late preview must not outlive its editor.
        return;
      }
      if (!reply.ok) {
        setError(reply.error.message);
        if (["CONFIGURATION_PREVIEW_EXPIRED", "CANCELLED", "ASSET_REVISION_CHANGED", "CONFIGURATION_PREVIEW_CHANGED", "TEAM_CHANGED"].includes(reply.error.code)) { token.current = null; setPreview(null); }
      }
      else if (reply.data.kind === "configuration-preview") { token.current = reply.data.value.token; setPreview(reply.data.value); }
      else if (reply.data.kind === "configuration-published") { token.current = null; running.current = false; onPublished(reply.data.value); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : l("The operation failed. Try again.", "操作未完成，请重试。")); }
    finally { running.current = false; onBusy(false); if (alive.current) setBusy(false); }
  }
  const currentFields = transport === "http" ? headers : environment, setFields = transport === "http" ? setHeaders : setEnvironment;
  return <dialog ref={dialog} className="team-share-dialog team-configuration-editor" aria-label={`${initial ? l("Edit", "编辑") : l("Add", "新增")} ${title}`} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <section className="team-workspace"><header className="team-workspace-head"><div><h2>{initial ? l("Edit", "编辑") : l("Add", "新增")} {title}</h2><p>{selection.team.name} · {selection.team.repository.replace("https://github.com/", "")}</p></div><button type="button" className="team-icon-button" disabled={busy} aria-label={l("Close editor", "关闭编辑")} onClick={onClose}><X size={18} /></button></header>
      {error && <p role="alert" className="team-workspace-error">{error}</p>}
      <form onSubmit={(event) => { event.preventDefault(); void run(Boolean(preview)); }}>
        {!preview ? <>
          <div className="team-editor-fields">
            {kind !== "environment" && <label>{l("Identifier", "标识")}<input required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={64} value={id} disabled={busy || Boolean(initial)} placeholder="team-review" onChange={event => setId(event.currentTarget.value)} /></label>}
            <label>{kind === "environment" ? l("Variable name", "变量名") : l("Name", "名称")}<input name="resource-name" required maxLength={kind === "environment" ? 128 : 200} pattern={kind === "environment" ? "[A-Za-z_][A-Za-z0-9_]*" : undefined} disabled={busy || kind === "environment" && Boolean(initial)} placeholder={kind === "environment" ? "TEAM_LOCALE" : undefined} value={name} onChange={event => setName(event.currentTarget.value)} /></label>
          </div>
          {kind === "instructions" && <label>{l("Instructions", "指令正文")}<textarea required rows={12} disabled={busy} value={content} onChange={event => setContent(event.currentTarget.value)} placeholder={l("Describe the conventions your team follows…", "填写团队开发约定…")} /></label>}
          {kind === "environment" && <label>{l("Shared value", "共享值")}<textarea rows={3} maxLength={8192} disabled={busy} value={value} onChange={event => setValue(event.currentTarget.value)} placeholder="zh-CN" /><small>{l("Saved in the team repository. Use only public values; MCP credentials can reference each member’s local variables.", "此值会写入团队仓库。这里只填写公共值；MCP 密钥可引用成员本机的环境变量。")}</small></label>}
          {kind === "mcp" && <>
            <label>{l("Connection", "连接方式")}<select disabled={busy} value={transport} onChange={event => setTransport(event.currentTarget.value as "http" | "stdio")}><option value="http">HTTP</option><option value="stdio">STDIO</option></select></label>
            {transport === "http" ? <label>{l("Server URL", "服务地址")}<input required type="url" maxLength={2048} disabled={busy} value={url} onChange={event => setUrl(event.currentTarget.value)} placeholder="https://example.com/mcp" /></label> : <><label>{l("Command", "启动命令")}<input required maxLength={2048} disabled={busy} value={command} onChange={event => setCommand(event.currentTarget.value)} placeholder="npx" /></label><label>{l("Arguments", "启动参数")}<textarea rows={3} disabled={busy} value={args} onChange={event => setArgs(event.currentTarget.value)} /><small>{l("A JSON array, with one value per argument.", "使用 JSON 数组，每个元素对应一个参数。")}</small></label></>}
            <fieldset><legend>{transport === "http" ? l("Request headers", "请求头") : l("Environment variables", "环境变量")}</legend>
              {currentFields.map((field, index) => <div className="team-editor-variable" key={index}><input aria-label={l("Field name ", "字段名 ") + (index + 1)} required maxLength={128} disabled={busy} value={field.key} onChange={event => setFields(currentFields.map((item, i) => i === index ? { ...item, key: event.currentTarget.value } : item))} placeholder={transport === "http" ? "Authorization" : "API_TOKEN"} /><select aria-label={l("Value source ", "值来源 ") + (index + 1)} disabled={busy} value={field.source} onChange={event => setFields(currentFields.map((item, i) => i === index ? { ...item, source: event.currentTarget.value as Field["source"] } : item))}><option value="value">{l("Shared value", "共享值")}</option><option value="environment">{l("Local variable name", "本机变量名")}</option></select><input aria-label={l("Field value ", "字段值 ") + (index + 1)} maxLength={8192} disabled={busy} readOnly={transport === "stdio" && field.source === "environment"} value={transport === "stdio" && field.source === "environment" ? field.key : field.value} onChange={event => setFields(currentFields.map((item, i) => i === index ? { ...item, value: event.currentTarget.value } : item))} /><button type="button" className="team-icon-button" disabled={busy} aria-label={l("Remove field ", "移除字段 ") + (index + 1)} onClick={() => setFields(currentFields.filter((_, i) => i !== index))}><X size={15} /></button></div>)}
              <button type="button" disabled={busy || currentFields.length >= 64} onClick={() => setFields([...currentFields, { key: "", value: "", source: "environment" }])}><Plus size={14} />{l("Add field", "添加字段")}</button>
              <small>{l("Local references store variable names only. Sync does not start the MCP server.", "本机引用只保存变量名，实际值由客户端读取。同步不会启动 MCP 服务。")}</small>
            </fieldset>
          </>}
          <fieldset><legend>{l("Clients", "适用客户端")}</legend><div className="team-space-actions">{(["codex", "claude"] as const).map(target => <label className="team-client-chip" key={target}><input type="checkbox" checked={targets.includes(target)} disabled={busy} onChange={event => setTargets(event.currentTarget.checked ? [...targets, target] : targets.filter(item => item !== target))} /><span>{target === "codex" ? "Codex" : "Claude Code"}</span></label>)}</div></fieldset>
        </> : <div className="team-editor-preview"><h3>{l("Review changes", "预览变更")}</h3><p>{preview.operation === "create" ? l("Add", "新增") : l("Update", "更新")} · {preview.name}</p><p>{l("Publishing updates the team repository. Sync team applies it to your working directories.", "发布会更新团队仓库；之后点击「同步团队」应用到工作目录。")}</p>{preview.files.map(file => <details key={file.path}><summary>{file.before === null ? l("New file", "新增文件") : l("Updated file", "更新文件")} · {file.path}</summary><div className="team-editor-diff"><section><strong>{l("Before", "修改前")}</strong><pre>{file.before ?? l("File does not exist", "尚无此文件")}</pre></section><section><strong>{l("After", "修改后")}</strong><pre>{file.after}</pre></section></div></details>)}</div>}
        <footer className="team-space-actions">{busy ? <button type="button" onClick={() => void api.request({ action: "cancel-sync" }).catch(() => { if (alive.current) setError(l("Cancellation could not be confirmed.", "取消未确认，请等待当前操作结束。")); })}>{l("Cancel operation", "取消操作")}</button> : preview ? <button type="button" onClick={backToEdit}>{l("Back to edit", "返回编辑")}</button> : <button type="button" onClick={onClose}>{l("Cancel", "取消")}</button>}<button className="is-primary" disabled={busy}>{busy ? l("Working…", "正在处理…") : preview ? l("Publish to team", "发布到团队") : l("Preview changes", "预览变更")}</button></footer>
      </form>
    </section>
  </dialog>;
}
