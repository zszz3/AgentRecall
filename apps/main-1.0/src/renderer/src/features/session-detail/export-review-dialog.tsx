import { useEffect, useMemo, useRef, useState } from "react";
import { applyRedactions, type ExportReview, type ReviewExportFormat } from "../../../../core/message-tools";
import { localize, type LanguageMode } from "../../language";

export function ExportReviewDialog({ sessionKey, language, onClose }: {
  sessionKey: string; language: LanguageMode; onClose(): void;
}) {
  const [review, setReview] = useState<ExportReview | null>(null);
  const [format, setFormat] = useState<ReviewExportFormat>("markdown");
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const api = window.sessionSearch.messageTools;
  const l = (en: string, zh: string) => localize(language, en, zh);
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setReview(null); setError(null);
    void api.prepare(sessionKey, format).then((next) => {
      if (cancelled) return;
      setReview(next);
      setChoices(Object.fromEntries(next.findings.map((item) => [item.id, item.replacement])));
    }).catch((reason: unknown) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; void api.release(); };
  }, [api, format, sessionKey]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);
  const selected = Object.entries(choices).map(([id, replacement]) => ({ id, replacement }));
  const preview = useMemo(() => review ? applyRedactions(review.text, review.findings,
    Object.entries(choices).map(([id, replacement]) => ({ id, replacement }))) : "", [review, choices]);
  async function save() {
    if (!review || busy) return;
    setBusy(true); setError(null);
    try { if (await api.save(review.id, selected)) onClose(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function addCustom() {
    if (!review || !custom || busy) return;
    setBusy(true); setError(null);
    try {
      const next = await api.addCustom(review.id, custom);
      const existing = new Set(review.findings.map((item) => item.id));
      setChoices((current) => ({ ...current, ...Object.fromEntries(next.findings.filter((item) => !existing.has(item.id)).map((item) => [item.id, item.replacement])) }));
      setReview(next); setCustom("");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="export-review-backdrop" onClick={(event) => event.stopPropagation()}>
    <div className="export-review-dialog" role="dialog" aria-modal="true" aria-label={l("Review export", "导出脱敏预览")}
      tabIndex={-1} ref={dialogRef} onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key === "Tab") {
          const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? []);
          const first = controls[0]; const last = controls.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header><h2>{l("Review & redact export", "导出脱敏预览")}</h2><button onClick={onClose}>{l("Close", "关闭")}</button></header>
      <p>{l("Detection is a local aid, not a guarantee. Review the complete output. Original messages and attachment files are not modified; attachment contents are not scanned.",
        "自动识别仅作辅助，请检查完整导出结果。原始消息和附件不会修改；附件文件内容不在扫描范围内。")}</p>
      <label>{l("Format", "格式")} <select disabled={busy} value={format} onChange={(event) => setFormat(event.target.value as ReviewExportFormat)}>
        <option value="markdown">Markdown</option><option value="text">{l("Plain text", "纯文本")}</option>
      </select></label>
      {error ? <p role="alert">{error}</p> : null}
      {busy ? <p role="status">{l("Working…", "处理中…")}</p> : null}
      {review ? <>
        <div className="export-review-custom"><input aria-label={l("Custom sensitive text", "手动指定敏感内容")} placeholder={l("Enter other text to hide", "输入其他需要隐藏的文字")} value={custom} maxLength={4096} onChange={(event) => setCustom(event.target.value)} />
          <button disabled={busy || !custom} onClick={() => void addCustom()}>{l("Add exact matches", "添加全部相同内容")}</button></div>
        <p>{l(`${review.findings.length} matches · ${selected.length} replacements`, `${review.findings.length} 处匹配 · 替换 ${selected.length} 处`)}</p>
        <div className="export-review-columns"><section className="export-review-findings" aria-label={l("Sensitive matches", "敏感内容匹配")}>
          {review.findings.length === 0 ? <p>{l("No automatic matches. You can add sensitive text manually.", "未自动发现匹配项，可以手动添加敏感内容。")}</p> : null}
          {review.findings.map((item) => <div key={item.id} className="export-review-finding">
            <label><input type="checkbox" disabled={busy} checked={item.id in choices} onChange={(event) => setChoices((current) => {
              const next = { ...current }; if (event.target.checked) next[item.id] = item.replacement; else delete next[item.id]; return next;
            })} />{l("Replace", "替换")} <mark>{review.text.slice(item.start, item.end)}</mark></label>
            <input aria-label={l(`Replacement ${item.id}`, `替换内容 ${item.id}`)} disabled={busy || !(item.id in choices)} maxLength={4096}
              value={choices[item.id] ?? item.replacement} onChange={(event) => setChoices((current) => ({ ...current, [item.id]: event.target.value }))} />
          </div>)}
        </section><section className="export-review-output">
          <label><input type="checkbox" checked={showOriginal} onChange={(event) => setShowOriginal(event.target.checked)} />{l("Show original with highlights", "查看原文及高亮")}</label>
          <pre tabIndex={0}>{showOriginal ? (() => {
            let cursor = 0;
            const chunks = review.findings.flatMap((item) => {
              const parts = [review.text.slice(cursor, item.start), <mark key={item.id}>{review.text.slice(item.start, item.end)}</mark>]; cursor = item.end; return parts;
            });
            return [...chunks, review.text.slice(cursor)];
          })() : preview}</pre>
        </section></div>
        <footer><button disabled={busy} onClick={() => void save()}>{l("Save reviewed export…", "保存已预览的导出…")}</button></footer>
      </> : null}
    </div>
  </div>;
}
