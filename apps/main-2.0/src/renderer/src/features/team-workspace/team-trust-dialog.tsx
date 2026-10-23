import { useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { TrustDecision, TrustItem } from "@agentrecall/workspace-core";
import type { LanguageMode } from "../../language";

/** Asks the member to trust or skip each script-bearing Skill and MCP server before Pull writes them into working directories. */
export function TeamTrustDialog({ items, language, onClose, onConfirm }: { items: TrustItem[]; language: LanguageMode; onClose(): void; onConfirm(decision: TrustDecision): void }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const dialog = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState<Record<string, "trust" | "skip">>({});
  useEffect(() => { const element = dialog.current; if (element && !element.open) element.showModal?.(); }, []);
  const set = (value: "trust" | "skip") => setChoices(Object.fromEntries(items.map(item => [item.key, value])));
  const complete = items.every(item => choices[item.key]);
  return <dialog ref={dialog} className="team-share-dialog team-trust-dialog" aria-label={l("Review team resources", "确认团队资源")} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><ShieldAlert size={18} aria-hidden="true" /><div><h2>{l("Review before Pull", "Pull 前确认")}</h2><p>{l("These resources can run programs or connect to services on this computer. Trust only what you recognise; skipped items are not installed and you will not be asked again until they change.", "以下资源会在本机运行程序或连接服务。只信任你认可的内容；跳过的项目不会安装，内容变化前不再询问。")}</p></div></header>
    <ul className="team-trust-list">
      {items.map(item => <li key={item.key}>
        <div><strong>{item.kind === "mcp" ? "MCP" : "Skill"} · {item.name}</strong><small>{item.reasons.join("、")}</small></div>
        <ul>{item.details.map(line => <li key={line}><code>{line}</code></li>)}</ul>
        <div role="radiogroup" aria-label={item.name}>
          <label><input type="radio" name={item.key} checked={choices[item.key] === "trust"} onChange={() => setChoices(current => ({ ...current, [item.key]: "trust" }))} />{l("Trust", "信任")}</label>
          <label><input type="radio" name={item.key} checked={choices[item.key] === "skip"} onChange={() => setChoices(current => ({ ...current, [item.key]: "skip" }))} />{l("Skip", "跳过")}</label>
        </div>
      </li>)}
    </ul>
    <footer className="team-space-actions">
      <button type="button" className="team-text-button" onClick={() => set("skip")}>{l("Skip all", "全部跳过")}</button>
      <button type="button" className="team-text-button" onClick={() => set("trust")}>{l("Trust all", "全部信任")}</button>
      <button type="button" onClick={onClose}>{l("Cancel", "取消")}</button>
      <button type="button" className="is-primary" disabled={!complete} onClick={() => onConfirm({ trusted: items.filter(item => choices[item.key] === "trust").map(item => item.key), skipped: items.filter(item => choices[item.key] === "skip").map(item => item.key) })}>{l("Continue Pull", "继续 Pull")}</button>
    </footer>
  </dialog>;
}
