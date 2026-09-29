import { memo, useMemo, useState } from "react";
import type { ConfigurationPreview } from "@agentrecall/workspace-core";
import { renderLineDiff } from "../../../../core/text-diff";
import type { LanguageMode } from "../../language";

export const TeamChangePreview = memo(function TeamChangePreview({ preview, language }: { preview: Pick<ConfigurationPreview, "files">; language: LanguageMode }) {
  return <div className="team-editor-preview">{preview.files.map((file, index) => <DiffFile key={file.path} file={file} language={language} initiallyOpen={index === 0} />)}</div>;
});
function DiffFile({ file, language, initiallyOpen }: { file: ConfigurationPreview["files"][number]; language: LanguageMode; initiallyOpen: boolean }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [open, setOpen] = useState(initiallyOpen), [mode, setMode] = useState<"diff" | "full">("diff");
  const lines = useMemo(() => {
    if (!open || mode !== "diff") return [];
    return renderLineDiff(file.before ?? "", file.after ?? "").split("\n");
  }, [file.before, file.after, open, mode]);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><b className={`team-diff-status ${file.after === null ? "deleted" : file.before === null ? "added" : "modified"}`}>{file.after === null ? "D" : file.before === null ? "A" : "M"}</b> {file.path}{file.executable !== undefined && file.previousExecutable !== file.executable && <small>{file.executable ? l("Executable", "可执行文件") : l("Regular file", "普通文件")}</small>}</summary>{open && <><div className="team-space-actions team-diff-modes"><button type="button" aria-pressed={mode === "diff"} onClick={() => setMode("diff")}>Diff</button><button type="button" aria-pressed={mode === "full"} onClick={() => setMode("full")}>{l("Full contents", "完整内容")}</button></div>{mode === "diff" ? <pre className="team-unified-diff" aria-label={l("File diff", "文件差异")}>{lines.map((line, index) => <span className={line.startsWith("+") ? "added" : line.startsWith("-") ? "deleted" : "context"} key={index}>{line}{"\n"}</span>)}</pre> : <div className="team-editor-diff"><section><strong>{l("Team version", "团队版本")}</strong><pre>{file.before ?? l("File does not exist", "尚无此文件")}</pre></section><section><strong>{l("Will upload", "将上传的版本")}</strong><pre>{file.after ?? l("File will be removed", "文件将被删除")}</pre></section></div>}</>}</details>;
}
