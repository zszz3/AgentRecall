import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, UIEvent } from "react";
import { CheckCircle2, Copy, FolderInput, FolderOpen, Search } from "lucide-react";
import type { InstalledSkill } from "../../../../core/skill-manager";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview } from "../../markdown-preview";
import {
  filterInstalledSkills,
  skillSourceLabel,
  sortInstalledSkills,
  type SkillSortKey,
  type SkillSourceFilter,
} from "../../skill-manager";

const LOCAL_SKILL_RENDER_BATCH = 60;
const LOCAL_SKILL_RENDER_THRESHOLD_PX = 160;

export function LocalSkillsTab({
  active,
  managedSourcePaths,
  refreshVersion,
  language,
  revealLabel,
  onCountChange,
  onImported,
  onCopyPath,
  onReveal,
}: {
  active: boolean;
  managedSourcePaths: Set<string>;
  refreshVersion: number;
  language: LanguageMode;
  revealLabel: string;
  onCountChange: (count: number) => void;
  onImported: (managedId: string) => void;
  onCopyPath: (skillPath: string) => void;
  onReveal: (directoryPath: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>("all");
  const [sort, setSort] = useState<SkillSortKey>("usage");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [visibleCount, setVisibleCount] = useState(LOCAL_SKILL_RENDER_BATCH);
  const mounted = useRef(true);
  const requestedRequestKey = useRef<string | null>(null);
  const loadedRequestKey = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const requestKey = `${refreshVersion}:${reloadVersion}`;
    if (loadedRequestKey.current === requestKey || requestedRequestKey.current === requestKey) return;
    requestedRequestKey.current = requestKey;
    setLoading(true);
    setError(null);
    window.sessionSearch.listSkillImportCandidates(refreshVersion > 0 || reloadVersion > 0)
      .then((snapshot) => {
        if (!mounted.current || requestedRequestKey.current !== requestKey) return;
        loadedRequestKey.current = requestKey;
        setSkills(snapshot.skills);
        setVisibleCount(LOCAL_SKILL_RENDER_BATCH);
        onCountChange(snapshot.skills.length);
        setSelectedPath((current) => current && snapshot.skills.some((skill) => skill.path === current)
          ? current
          : null);
      })
      .catch((reason) => {
        if (!mounted.current || requestedRequestKey.current !== requestKey) return;
        requestedRequestKey.current = null;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!mounted.current) return;
        if (loadedRequestKey.current === requestKey || requestedRequestKey.current === null) setLoading(false);
      });
  }, [active, onCountChange, refreshVersion, reloadVersion]);

  const filteredSkills = useMemo(
    () => sortInstalledSkills(filterInstalledSkills(skills, query, sourceFilter), sort),
    [query, skills, sort, sourceFilter],
  );
  const visibleSkills = filteredSkills.slice(0, visibleCount);
  const selectedSkill = visibleSkills.find((skill) => skill.path === selectedPath) ?? visibleSkills[0] ?? null;

  useEffect(() => {
    if (selectedSkill && selectedSkill.path !== selectedPath) setSelectedPath(selectedSkill.path);
    if (!selectedSkill && selectedPath) setSelectedPath(null);
  }, [selectedPath, selectedSkill]);

  const showMoreSkillsNearBottom = (event: UIEvent<HTMLDivElement>) => {
    if (visibleCount >= filteredSkills.length) return;
    const list = event.currentTarget;
    if (list.scrollTop + list.clientHeight < list.scrollHeight - LOCAL_SKILL_RENDER_THRESHOLD_PX) return;
    setVisibleCount((current) => Math.min(current + LOCAL_SKILL_RENDER_BATCH, filteredSkills.length));
  };

  const addToApp = async (skill: InstalledSkill) => {
    if (managedSourcePaths.has(skill.directoryPath) || importingPath) return;
    setImportingPath(skill.path);
    setError(null);
    try {
      const result = await window.sessionSearch.importLocalSkills([skill.path]);
      const managedId = result[0]?.managedId;
      if (!managedId) throw new Error(l("The Skill was not added to this app.", "Skill 未能加入本 App。"));
      onImported(managedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImportingPath(null);
    }
  };

  return (
    <section
      id="local-skills-panel"
      className="skill-tab-panel local-skills-panel"
      role="tabpanel"
      aria-labelledby="local-skills-tab"
      hidden={!active}
    >
      {error ? (
        <div className="managed-skills-feedback error">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadVersion((value) => value + 1)}>{l("Retry", "重试")}</button>
        </div>
      ) : null}
      <div className="managed-skills-grid local-skills-grid">
        <aside className="skill-library-list">
          <div className="skill-library-list-tools">
            <label className="skill-library-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setVisibleCount(LOCAL_SKILL_RENDER_BATCH);
                }}
                placeholder={l("Search local Skills", "搜索本地 Skill")}
                aria-label={l("Search local Skills", "搜索本地 Skill")}
              />
            </label>
            <div className="skill-library-filter-row">
              <select
                value={sourceFilter}
                onChange={(event) => {
                  setSourceFilter(event.currentTarget.value as SkillSourceFilter);
                  setVisibleCount(LOCAL_SKILL_RENDER_BATCH);
                }}
                aria-label={l("Filter local Skills", "筛选本地 Skill")}
              >
                <option value="all">{l("All sources", "全部来源")}</option>
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
                <option value="shared">{l("Shared", "共享")}</option>
                <option value="project">{l("Project", "项目")}</option>
              </select>
              <select
                value={sort}
                onChange={(event) => {
                  setSort(event.currentTarget.value as SkillSortKey);
                  setVisibleCount(LOCAL_SKILL_RENDER_BATCH);
                }}
                aria-label={l("Sort local Skills", "排序本地 Skill")}
              >
                <option value="usage">{l("Most used", "最常使用")}</option>
                <option value="name">{l("Name", "名称")}</option>
                <option value="updated">{l("Recently updated", "最近更新")}</option>
              </select>
            </div>
          </div>

          <div
            className="skill-library-scroll"
            role="listbox"
            aria-label={l("Local Skills", "本地 Skill")}
            onScroll={showMoreSkillsNearBottom}
          >
            {loading && skills.length === 0 ? <div className="skill-library-empty">{l("Scanning local Skills…", "正在扫描本地 Skill…")}</div> : null}
            {!loading && filteredSkills.length === 0 ? (
              <div className="skill-library-empty">
                <strong>{l("No local Skills", "没有找到本地 Skill")}</strong>
                <span>{l("Agent Skills found on this machine will appear here.", "本机 Agent 已安装的 Skill 会显示在这里。")}</span>
              </div>
            ) : null}
            {visibleSkills.map((skill) => {
              const activeRow = skill.path === selectedSkill?.path;
              const managed = managedSourcePaths.has(skill.directoryPath);
              return (
                <div
                  key={skill.path}
                  className={`skill-library-row local-skill-row ${activeRow ? "active" : ""}`}
                  role="option"
                  aria-selected={activeRow}
                  tabIndex={activeRow ? 0 : -1}
                  onClick={() => setSelectedPath(skill.path)}
                >
                  <span className={`local-skill-state ${managed ? "managed" : ""}`} aria-hidden="true">
                    {managed ? <CheckCircle2 size={13} /> : null}
                  </span>
                  <div className="skill-library-row-copy">
                    <div className="skill-library-row-title">
                      <strong title={skill.name}>{skill.name}</strong>
                      <span>{skillSourceLabel(skill.source)}</span>
                    </div>
                    <p>{skill.description || l("No description", "暂无说明")}</p>
                    <div className="skill-library-row-meta local-skill-row-meta">
                      <span title={skill.path}>{l(`Used ${skill.usageCount ?? 0} times`, `使用 ${skill.usageCount ?? 0} 次`)}</span>
                      {managed ? <em>{l("In this app", "已在本 App")}</em> : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        <main className={`skill-library-detail local-skill-detail ${selectedSkill ? "" : "empty"}`}>
          {!selectedSkill ? (
            <div className="skill-library-detail-empty">
              <strong>{l("Choose a local Skill", "选择一个本地 Skill")}</strong>
              <span>{l("Its source, path, and documentation will appear here.", "这里会显示来源、路径和说明文档。")}</span>
            </div>
          ) : (
            <>
              <header className="managed-skill-head">
                <div className="managed-skill-title">
                  <div><h3>{selectedSkill.name}</h3><span>{skillSourceLabel(selectedSkill.source)}</span></div>
                  <p>{selectedSkill.description || l("No description", "暂无说明")}</p>
                </div>
                <div className="managed-skill-actions local-skill-actions">
                  {!managedSourcePaths.has(selectedSkill.directoryPath) ? (
                    <button
                      type="button"
                      className="local-skill-add-action"
                      disabled={Boolean(importingPath)}
                      onClick={() => void addToApp(selectedSkill)}
                    >
                      <FolderInput size={13} />
                      {importingPath === selectedSkill.path ? l("Adding…", "正在加入…") : l("Add to this app", "加入本 App")}
                    </button>
                  ) : <span className="local-skill-managed-label"><CheckCircle2 size={13} />{l("In this app", "已在本 App")}</span>}
                  <button type="button" onClick={() => onCopyPath(selectedSkill.path)} title={l("Copy path", "复制路径")} aria-label={l("Copy path", "复制路径")}><Copy size={14} /></button>
                  <button type="button" onClick={() => onReveal(selectedSkill.directoryPath)} title={l(`Show in ${revealLabel}`, `在 ${revealLabel} 中显示`)} aria-label={l(`Show in ${revealLabel}`, `在 ${revealLabel} 中显示`)}><FolderOpen size={14} /></button>
                </div>
              </header>
              <section className="local-skill-path" title={selectedSkill.path}>
                <span>{l("Local path", "本地路径")}</span><code>{selectedSkill.path}</code>
              </section>
              <section className="managed-skill-document local-skill-document">
                <div className="managed-skill-document-head"><span>SKILL.md</span><small>{skillSourceLabel(selectedSkill.source)}</small></div>
                <div className="managed-skill-markdown">
                  <Markdown text={markdownPreview(selectedSkill.markdown, 18_000, l("…(truncated)", "…（已截断）"))} language={language} />
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </section>
  );
}
