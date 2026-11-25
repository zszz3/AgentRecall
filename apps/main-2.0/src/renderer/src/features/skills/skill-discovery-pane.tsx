import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { Check, Download, ExternalLink, FolderInput, Plus, Search, Sparkles, Trophy } from "lucide-react";
import type { SkillAiSearchResult } from "../../../../core/skill-ai-search";
import type { SkillsShDetail, SkillsShEntry } from "../../../../core/skills-sh";
import type { SkillInstallTarget } from "../../../../core/managed-skill-library";
import { formatCompactNumber } from "../../format-count";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { Button } from "../../ui/primitives";

export function SkillDiscoveryPane({
  language,
  availableTargets,
  targetLabels,
  onImported,
  onCreateNew,
  onImportFolder,
}: {
  language: LanguageMode;
  availableTargets: SkillInstallTarget[];
  targetLabels: Record<SkillInstallTarget, string>;
  onImported: (managedId: string, installedTargets: SkillInstallTarget[]) => void;
  onCreateNew: () => void;
  onImportFolder: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [skills, setSkills] = useState<Array<SkillsShEntry | SkillAiSearchResult["skills"][number]>>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [stale, setStale] = useState(false);
  const [searchMode, setSearchMode] = useState<"leaderboard" | "keyword" | "ai">("leaderboard");
  const [aiResult, setAiResult] = useState<SkillAiSearchResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillsShDetail | null>(null);
  const [selectedTargets, setSelectedTargets] = useState<SkillInstallTarget[]>(() => availableTargets.slice(0, 2));
  const [loading, setLoading] = useState(false);
  const [aiSearching, setAiSearching] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    setSelectedTargets((current) => {
      const kept = current.filter((target) => availableTargets.includes(target));
      if (kept.length > 0) return kept;
      return availableTargets.slice(0, 2);
    });
  }, [availableTargets]);

  const loadPage = async (nextPage: number, nextQuery: string, append: boolean) => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.sessionSearch.listDiscoveredSkills({ page: nextPage, query: nextQuery });
      if (requestVersion !== requestVersionRef.current) return;
      setSkills((current) => {
        const merged = append ? dedupeEntries([...current, ...result.skills]) : result.skills;
        setSelectedId((prev) => (prev && merged.some((entry) => entry.id === prev) ? prev : merged[0]?.id ?? null));
        return merged;
      });
      setPage(result.page);
      setTotal(result.total);
      setHasMore(result.hasMore);
      setStale(result.stale);
    } catch (reason) {
      if (requestVersion !== requestVersionRef.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void loadPage(0, "", false);
    return () => { requestVersionRef.current += 1; };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    window.sessionSearch.getDiscoveredSkill(selectedId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((reason) => {
        if (!cancelled) setDetailError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId]);

  const selectedAiMatch = searchMode === "ai"
    ? aiResult?.skills.find((skill) => skill.id === selectedId) ?? null
    : null;

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (loading) return;
    const next = input.trim();
    setQuery(next);
    setSearchMode(next ? "keyword" : "leaderboard");
    setAiResult(null);
    setAiSearching(false);
    setSelectedId(null);
    setDetail(null);
    void loadPage(0, next, false);
  };

  const runAiSearch = async () => {
    const next = input.trim();
    if (!next) {
      setError(l("Describe the capability you want to find.", "先描述你想寻找的能力。"));
      inputRef.current?.focus();
      return;
    }
    if (aiSearching) return;
    const requestVersion = ++requestVersionRef.current;
    setQuery(next);
    setSearchMode("ai");
    setAiResult(null);
    setSkills([]);
    setSelectedId(null);
    setDetail(null);
    setLoading(true);
    setAiSearching(true);
    setError(null);
    try {
      const result = await window.sessionSearch.aiSearchDiscoveredSkills({ query: next, language });
      if (requestVersion !== requestVersionRef.current) return;
      setAiResult(result);
      setSkills(result.skills);
      setTotal(result.total);
      setHasMore(false);
      setStale(result.stale);
      setSelectedId(result.skills[0]?.id ?? null);
    } catch (reason) {
      if (requestVersion !== requestVersionRef.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setLoading(false);
        setAiSearching(false);
      }
    }
  };

  const toggleTarget = (target: SkillInstallTarget) => {
    setSelectedTargets((current) =>
      current.includes(target) ? current.filter((item) => item !== target) : [...current, target],
    );
  };

  const importAndInstall = async () => {
    if (!selectedId) return;
    setImporting(true);
    setDetailError(null);
    try {
      const result = await window.sessionSearch.importDiscoveredSkill(selectedId);
      let installedTargets: SkillInstallTarget[] = [];
      if (selectedTargets.length > 0 && window.sessionSearch.updateManagedSkillTargets) {
        try {
          await window.sessionSearch.updateManagedSkillTargets(result.managedId, selectedTargets, []);
          installedTargets = selectedTargets;
        } catch (installError) {
          // Imported successfully; surface any target conflict cleanly on the Skill detail page.
          setDetailError(installError instanceof Error ? installError.message : String(installError));
        }
      }
      onImported(result.managedId, installedTargets);
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="skill-discovery-pane">
      <div className="skill-discovery-topbar">
        <form className="skill-discovery-search" onSubmit={submitSearch}>
          <span className="skill-discovery-search-field">
            <Search size={14} />
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              placeholder={l("Search skills.sh by keyword, or describe the capability you need…", "按关键词搜索 skills.sh，或描述你需要解决的问题…")}
            />
          </span>
          <button type="submit" className="skill-discovery-keyword-action" disabled={loading}>
            {l("Search", "搜索")}
          </button>
          <button type="button" className="skill-discovery-ai-action" onClick={() => void runAiSearch()} disabled={aiSearching}>
            <Sparkles size={13} />{aiSearching ? l("Exploring…", "探索中…") : l("AI explore", "AI 探索")}
          </button>
        </form>
        <div className="skill-discovery-local-actions">
          <Button size="sm" icon={<FolderInput size={14} />} onClick={onImportFolder}>
            {l("Import folder", "导入本地目录")}
          </Button>
          <Button size="sm" icon={<Plus size={14} />} onClick={onCreateNew}>
            {l("New Skill", "新建 Skill")}
          </Button>
        </div>
      </div>

      {aiResult ? (
        <div className="skill-discovery-ai-insight">
          <Sparkles size={14} />
          <div>
            <strong>{aiResult.interpretation || l("Matched Skills for your request", "已按你的需求匹配 Skill")}</strong>
            <span className="skill-discovery-ai-queries">
              {aiResult.queries.map((item) => <code key={item}>{item}</code>)}
            </span>
          </div>
          {aiResult.partial ? <small>{l("Partial results", "部分结果")}</small> : null}
        </div>
      ) : null}

      <div className="skill-discovery-meta">
        <span>
          {searchMode === "ai"
            ? l(`AI matches · ${total}`, `AI 匹配 · ${total}`)
            : query
              ? l(`Results for “${query}”`, `“${query}”的结果`)
              : l(`All-time leaderboard · ${total}`, `skills.sh 热门榜 · ${total}`)}
        </span>
        {stale ? <span className="stale">{l("Offline cache", "离线缓存")}</span> : null}
      </div>

      {error ? (
        <div className="managed-skill-dialog-error">
          {error}
          <button type="button" onClick={() => (searchMode === "ai" ? void runAiSearch() : void loadPage(0, query, false))}>
            {l("Retry", "重试")}
          </button>
        </div>
      ) : null}

      <div className="skill-discovery-workspace skill-discovery-workspace-embedded">
        <div className="skill-discovery-list">
          {loading && skills.length === 0 ? (
            <div className="managed-skill-dialog-empty">
              {aiSearching ? l("Understanding your request and searching…", "正在理解需求并搜索…") : l("Loading leaderboard…", "正在加载榜单…")}
            </div>
          ) : null}
          {!loading && skills.length === 0 ? (
            <div className="managed-skill-dialog-empty">{l("No Skills found.", "没有找到 Skill。")}</div>
          ) : null}
          {skills.map((skill, index) => (
            <button
              key={skill.id}
              type="button"
              className={selectedId === skill.id ? "active" : ""}
              onClick={() => setSelectedId(skill.id)}
            >
              <span className="skill-discovery-rank">
                {searchMode === "ai" ? <Sparkles size={12} /> : query ? <Search size={12} /> : index < 3 ? <Trophy size={12} /> : index + 1}
              </span>
              <span>
                <strong>{skill.name}</strong>
                <small>{skill.source}</small>
                {searchMode === "ai" && "description" in skill ? (
                  <small className="skill-discovery-description">{skill.description}</small>
                ) : null}
              </span>
              <span className="skill-discovery-installs">{formatCompactNumber(skill.installs)}</span>
            </button>
          ))}
          {hasMore && searchMode === "leaderboard" ? (
            <button
              type="button"
              className="skill-discovery-more"
              onClick={() => void loadPage(page + 1, "", true)}
              disabled={loading}
            >
              {loading ? l("Loading…", "加载中…") : l("Load more", "加载更多")}
            </button>
          ) : null}
        </div>

        <div className="skill-discovery-detail">
          {detailLoading ? <div className="managed-skill-dialog-empty">{l("Loading Skill…", "正在加载 Skill…")}</div> : null}
          {detailError ? <div className="managed-skill-dialog-error">{detailError}</div> : null}
          {!detailLoading && detail ? (
            <>
              <header>
                <div>
                  <h4>{detail.entry.name}</h4>
                  <p>{detail.entry.source} · {formatCompactNumber(detail.entry.installs)} {l("installs", "次安装")}</p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void window.sessionSearch.openExternalLink(detail.entry.url)}
                  title={l("Open skills.sh", "打开 skills.sh")}
                >
                  <ExternalLink size={14} />
                </button>
              </header>
              {selectedAiMatch ? (
                <div className="skill-discovery-match-reason">
                  <strong>{l("Why it matches", "匹配原因")}</strong>
                  <p>{selectedAiMatch.reason}</p>
                </div>
              ) : null}
              <div className="skill-discovery-markdown">
                <Markdown text={detail.markdown} language={language} />
              </div>
              <footer className="skill-discovery-install-footer">
                <div className="skill-discovery-target-picker">
                  <span className="skill-discovery-target-label">
                    {l(`${detail.files.length} files · Install to:`, `${detail.files.length} 个文件 · 安装到：`)}
                  </span>
                  <div className="skill-discovery-target-chips">
                    {availableTargets.map((target) => {
                      const active = selectedTargets.includes(target);
                      return (
                        <button
                          key={target}
                          type="button"
                          className={`skill-agent-pill skill-agent-pill-compact${active ? " is-installed" : ""}`}
                          aria-pressed={active}
                          onClick={() => toggleTarget(target)}
                        >
                          {active ? <Check size={11} /> : <Plus size={11} />}
                          <span>{targetLabels[target]}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button type="button" className="primary" onClick={() => void importAndInstall()} disabled={importing}>
                  <Download size={13} />
                  {importing
                    ? l("Installing…", "正在安装…")
                    : selectedTargets.length > 0
                      ? l(`Install (${selectedTargets.length})`, `一键安装（${selectedTargets.length}）`)
                      : l("Add to library", "仅加入库")}
                </button>
              </footer>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function dedupeEntries(entries: SkillsShEntry[]): SkillsShEntry[] {
  const byId = new Map<string, SkillsShEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}
