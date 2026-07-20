import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Check, Download, Search, X } from "lucide-react";
import type { InstalledSkill } from "../../../../core/skill-manager";
import { localize, type LanguageMode } from "../../language";
import { skillSourceLabel } from "../../skill-manager";

export function SkillImportDialog({
  open,
  language,
  onClose,
  onImported,
}: {
  open: boolean;
  language: LanguageMode;
  onClose: () => void;
  onImported: (managedId: string | null) => void;
}): ReactElement | null {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [candidates, setCandidates] = useState<InstalledSkill[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await window.sessionSearch.listSkillImportCandidates();
      setCandidates(snapshot.skills);
      setSelected(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return candidates;
    return candidates.filter((skill) => [skill.name, skill.description, skill.path, skillSourceLabel(skill.source)]
      .join("\n").toLowerCase().includes(normalized));
  }, [candidates, query]);

  if (!open) return null;

  const importSelected = async () => {
    const selectedCandidates = candidates.filter((skill) => selected.has(skill.path));
    if (selectedCandidates.length === 0) return;
    setImporting(true);
    setError(null);
    let lastManagedId: string | null = null;
    const failures: string[] = [];
    const importedPaths = new Set<string>();
    for (const candidate of selectedCandidates) {
      try {
        const result = await window.sessionSearch.importLocalSkills([candidate.path]);
        lastManagedId = result[0]?.managedId ?? lastManagedId;
        importedPaths.add(candidate.path);
      } catch (reason) {
        failures.push(`${candidate.name}: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
    setImporting(false);
    if (lastManagedId) onImported(lastManagedId);
    if (failures.length > 0) {
      setCandidates((current) => current.filter((candidate) => !importedPaths.has(candidate.path)));
      setSelected((current) => new Set([...current].filter((candidatePath) => !importedPaths.has(candidatePath))));
      setError(failures.slice(0, 3).join(" · "));
      return;
    }
    onClose();
  };

  return (
    <div className="dialog-backdrop managed-skill-dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog managed-skill-task-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header className="managed-skill-dialog-head">
          <div><h3>{l("Import local Skills", "导入本机 Skill")}</h3><p>{l("Choose existing Skills to copy into AgentRecall. Original folders stay untouched.", "选择要复制到 AgentRecall 的已有 Skill，原目录不会改变。")}</p></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}><X size={16} /></button>
        </header>
        <label className="managed-skill-dialog-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={l("Search local Skills", "搜索本机 Skill")} />
        </label>
        {error ? <div className="managed-skill-dialog-error">{error}<button type="button" onClick={() => void load()}>{l("Retry", "重试")}</button></div> : null}
        <div className="managed-skill-candidate-list">
          {loading ? <div className="managed-skill-dialog-empty">{l("Scanning local Skills…", "正在扫描本机 Skill…")}</div> : null}
          {!loading && filtered.length === 0 ? <div className="managed-skill-dialog-empty">{l("No importable Skills found.", "没有找到可导入的 Skill。")}</div> : null}
          {filtered.map((skill) => {
            const checked = selected.has(skill.path);
            return (
              <button
                key={skill.id}
                type="button"
                className={`managed-skill-candidate ${checked ? "selected" : ""}`}
                onClick={() => setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(skill.path)) next.delete(skill.path);
                  else next.add(skill.path);
                  return next;
                })}
              >
                <span className="managed-skill-candidate-check">{checked ? <Check size={12} /> : null}</span>
                <span><strong>{skill.name}</strong><small>{skillSourceLabel(skill.source)}</small><p>{skill.description || l("No description", "暂无说明")}</p><code title={skill.path}>{skill.path}</code></span>
              </button>
            );
          })}
        </div>
        <footer className="managed-skill-dialog-actions">
          <span>{l(`${selected.size} selected`, `已选择 ${selected.size} 个`)}</span>
          <button type="button" onClick={onClose} disabled={importing}>{l("Cancel", "取消")}</button>
          <button type="button" className="primary" onClick={() => void importSelected()} disabled={selected.size === 0 || importing}>
            <Download size={13} />{importing ? l("Importing…", "正在导入…") : l("Import selected", "导入所选")}
          </button>
        </footer>
      </section>
    </div>
  );
}
