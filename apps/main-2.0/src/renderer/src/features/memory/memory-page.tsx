import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ArrowUpFromLine, Cpu, MoreHorizontal, RefreshCw, RotateCcw, Trash2 } from "lucide-react";

import { agentModelLabel } from "../../../../core/agent-model-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { ExperienceCardStatus, MemoryCard } from "../../../../shared/ipc/experience-cards";
import type { LibrarySkillDraft } from "../../../../shared/ipc/skills";
import { localize, type LanguageMode } from "../../language";
import { ResizableSplit } from "../../components/resizable-split";
import { CatalogDetail, CatalogGroup, CatalogItem, CatalogPage, CatalogSearch } from "../../ui/catalog";
import { MenuButton } from "../../ui/menu";
import { Badge, Button, EmptyState, IconButton, Switch } from "../../ui/primitives";
import { errorText } from "../status/status-messages";
import { cardSkill } from "./card-promotion";

interface MemoryPageProps {
  language: LanguageMode;
  settings: AppSettings | null;
  onSettingsChange: (update: AppSettingsUpdate) => Promise<void>;
  /** Opens Provider → AgentRecall model, where extraction's model and key are set up. */
  onOpenAgentModel: () => void;
  onViewSource: (sessionKey: string, turnIndex: number) => void;
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

/**
 * Experience cards extracted from Sessions, shown read-only by project. The header holds the
 * extraction switch, its model and progress; cards can be opened at their source Turns, promoted
 * to a Skill or deleted. Agents keep cards current, so the page does not edit them.
 */
export function MemoryPage({ language, settings, onSettingsChange, onOpenAgentModel, onViewSource }: MemoryPageProps): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [status, setStatus] = useState<ExperienceCardStatus | null>(null);
  const [cards, setCards] = useState<MemoryCard[] | null>(null);
  const [query, setQuery] = useState("");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState<(LibrarySkillDraft & { cardId: string }) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRequest = useRef(0);

  const enabled = Boolean(settings?.experienceCardsEnabled);
  const model = agentModelLabel(settings?.agentModel);

  const refreshStatus = useCallback(async () => {
    setStatus(await window.sessionSearch.getExperienceCardStatus());
  }, []);

  const refreshCards = useCallback(async (nextQuery: string, nextIncludeSuperseded: boolean) => {
    const request = ++listRequest.current;
    const result = await window.sessionSearch.listExperienceCards({ query: nextQuery, includeSuperseded: nextIncludeSuperseded });
    if (request === listRequest.current) setCards(result);
  }, []);

  useEffect(() => {
    void refreshStatus().catch((cause) => setError(errorText(cause)));
  }, [refreshStatus]);

  useEffect(() => {
    void refreshCards(query, includeSuperseded).catch((cause) => setError(errorText(cause)));
  }, [query, includeSuperseded, refreshCards]);

  const groups = useMemo(() => {
    const byProject = new Map<string, MemoryCard[]>();
    for (const card of cards ?? []) byProject.set(card.projectPath, [...(byProject.get(card.projectPath) ?? []), card]);
    return [...byProject.entries()];
  }, [cards]);
  const ordered = groups.flatMap(([, projectCards]) => projectCards);
  const current = ordered.find((card) => card.id === selectedId) ?? ordered[0] ?? null;

  async function act(key: string, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }

  const toggle = () => act("toggle", async () => {
    if (!enabled && !model) {
      throw new Error(l("Set up the AgentRecall model before turning extraction on.", "请先设置 AgentRecall 模型，再开启。"));
    }
    await onSettingsChange({ experienceCardsEnabled: !enabled });
    await refreshStatus();
  });

  const retry = (sessionKey: string | null) => act(`retry:${sessionKey ?? "all"}`, async () => {
    await window.sessionSearch.retryExperienceExtraction(sessionKey);
    await refreshStatus();
  });

  // Promotion writes nothing by itself here: the Skill goes into the library only after the member reviews the draft.
  const createSkill = (current: LibrarySkillDraft & { cardId: string }) => act(`skill:${current.cardId}`, async () => {
    const { cardId: _cardId, ...skill } = current;
    const result = await window.sessionSearch.createLibrarySkill(skill);
    if (result.status === "conflict") {
      throw new Error(l(`The Skill library already has a different "${skill.id}". Choose another ID.`, `Skill 库里已经有另一个「${skill.id}」，请换一个标识。`));
    }
    setSkillDraft(null);
    setNotice(result.status === "existing"
      ? l(`The Skill library already has the same "${skill.id}".`, `Skill 库里已经有相同的「${skill.id}」。`)
      : l(`Added "${skill.id}" to the Skill library. Install it to agents on the Skills page, or add it to a team under Team Skills.`, `已把「${skill.id}」加入 Skill 库，可以在 Skills 页安装到各个 Agent，也可以在「团队 Skill」里加进团队。`));
  });

  const remove = (card: MemoryCard) => act(`delete:${card.id}`, async () => {
    if (!window.confirm(l(
      `Delete this experience card? Agents will no longer find it.\n\n${card.problem}`,
      `删除这张经验卡？删除后 Agent 将无法再搜到它。\n\n${card.problem}`,
    ))) return;
    await window.sessionSearch.deleteExperienceCard(card.id);
    setCards((previous) => previous?.filter((item) => item.id !== card.id) ?? null);
    await refreshStatus();
  });

  const tokens = (value: number | null | undefined) => value === null || value === undefined ? l("unknown", "未知") : value.toLocaleString();
  const turns = (first: number, last: number) => first === last
    ? l(`Turn ${first + 1}`, `第 ${first + 1} 轮`)
    : l(`Turns ${first + 1}–${last + 1}`, `第 ${first + 1}–${last + 1} 轮`);
  const kindLabel = (card: MemoryCard) => card.kind === "decision" ? l("Decision", "决策") : l("Experience", "经验");

  const meta = cards === null ? l("Loading cards…", "正在读取经验卡…")
    : l(`${cards.length} cards · ${groups.length} projects`, `${cards.length} 张经验卡 · ${groups.length} 个项目`);

  const statusLine = status ? [
    status.running ? l("Processing", "处理中") : enabled ? l("Waiting for new Turns", "等待新的轮次") : l("Extraction off", "提炼已关闭"),
    l(`${status.processedToday} Sessions today, ${status.processedSessions} in total`, `今日处理 ${status.processedToday} 个会话，累计 ${status.processedSessions} 个`),
    l(`Tokens ${tokens(status.inputTokens)} in / ${tokens(status.outputTokens)} out`, `Token ${tokens(status.inputTokens)} / ${tokens(status.outputTokens)}`),
  ].join(" · ") : null;

  const actions = <>
    <span className="memory-extraction">
      <Switch label={l("Extract experience cards", "提炼经验卡")} checked={enabled} disabled={!settings || busy !== null} onChange={() => void toggle()} />
      <span>{l("Extract", "提炼")}</span>
    </span>
    <Button size="sm" variant="ghost" icon={<Cpu size={14} />} onClick={onOpenAgentModel}>
      {model ?? l("Set up model", "设置模型")}
    </Button>
    <MenuButton
      className="ui-button ui-icon-button ui-button-ghost ui-button-md"
      label={l("More", "更多")}
      icon={<MoreHorizontal size={15} />}
      items={[{
        key: "superseded",
        label: includeSuperseded ? l("Hide superseded cards", "隐藏已被取代的卡片") : l("Show superseded cards", "显示已被取代的卡片"),
        onSelect: () => setIncludeSuperseded((value) => !value),
      }]}
    />
    <IconButton
      label={l("Refresh", "刷新")}
      icon={<RefreshCw size={15} />}
      onClick={() => void Promise.all([refreshStatus(), refreshCards(query, includeSuperseded)]).catch((cause) => setError(errorText(cause)))}
    />
  </>;

  const list = <div className="catalog-list" aria-label={l("Experience cards", "经验卡")}>
    {groups.map(([projectPath, projectCards]) => (
      <CatalogGroup key={projectPath} title={projectPath ? folderName(projectPath) : l("No project", "无项目")} hint={projectPath} count={projectCards.length}>
        {projectCards.map((card) => <CatalogItem
          key={card.id}
          title={card.problem}
          meta={`${kindLabel(card)} · ${new Date(card.updatedAt).toLocaleDateString()}`}
          trailing={card.status === "superseded" ? <Badge>{l("Superseded", "已被取代")}</Badge> : undefined}
          selected={current?.id === card.id}
          onSelect={() => { setSelectedId(card.id); setSkillDraft(null); setNotice(null); }}
        />)}
      </CatalogGroup>
    ))}
    {cards !== null && cards.length === 0 ? <p className="catalog-list-empty">{query
      ? l("No cards match this search.", "没有匹配的经验卡。")
      : l("No experience cards yet.", "还没有经验卡。")}</p> : null}
  </div>;

  let detail: ReactElement;
  if (!current) {
    detail = <EmptyState
      title={cards === null ? l("Loading cards…", "正在读取经验卡…") : l("No experience cards", "没有经验卡")}
      description={l(
        "Turn on extraction in the header. Cards appear after Sessions you finish from then on are processed; agents find them when they search past Sessions.",
        "在顶部开启提炼。之后完成的会话处理完会出现卡片，Agent 搜索历史会话时会先看到它们。",
      )}
    />;
  } else {
    const card = current;
    const drafting = skillDraft?.cardId === card.id ? skillDraft : null;
    detail = <CatalogDetail
      title={card.problem}
      subtitle={card.projectPath ? <code>{card.projectPath}</code> : undefined}
      facts={[
        { label: l("Kind", "类型"), value: kindLabel(card) },
        { label: l("State", "状态"), value: card.status === "superseded" ? l("Superseded", "已被取代") : l("Active", "有效") },
        { label: l("Updated", "更新时间"), value: new Date(card.updatedAt).toLocaleString() },
        ...(card.model ? [{ label: l("Model", "模型"), value: card.model }] : []),
      ]}
      actions={<>
        {card.status === "active" ? <Button size="sm" icon={<ArrowUpFromLine size={14} />} disabled={busy !== null || drafting !== null}
          onClick={() => { setNotice(null); setError(null); setSkillDraft({ cardId: card.id, ...cardSkill(card, l) }); }}>
          {l("Promote to Skill", "提升为 Skill")}
        </Button> : null}
        <IconButton label={l("Delete card", "删除卡片")} icon={<Trash2 size={14} />} disabled={busy !== null} onClick={() => void remove(card)} />
      </>}
    >
      {notice ? <p className="ui-notice ui-notice-success" role="status">{notice}</p> : null}
      {drafting ? (
        <form className="memory-skill-form" onSubmit={(event) => { event.preventDefault(); void createSkill(drafting); }}>
          <label><span>{l("Skill ID", "Skill 标识")}</span><input name="skill-id" value={drafting.id} pattern="[a-z0-9][a-z0-9._\-]*" maxLength={80} required onChange={(event) => setSkillDraft({ ...drafting, id: event.currentTarget.value })} /></label>
          <label><span>{l("Description (when agents should use it)", "说明（Agent 何时使用）")}</span><input name="skill-description" value={drafting.description} maxLength={1024} required onChange={(event) => setSkillDraft({ ...drafting, description: event.currentTarget.value })} /></label>
          <label><span>{l("Content", "内容")}</span><textarea value={drafting.body} required onChange={(event) => setSkillDraft({ ...drafting, body: event.currentTarget.value })} /></label>
          <div className="ui-form-actions">
            <Button size="sm" onClick={() => setSkillDraft(null)} disabled={busy !== null}>{l("Cancel", "取消")}</Button>
            <Button size="sm" variant="primary" type="submit" disabled={busy !== null}>
              {busy === `skill:${card.id}` ? l("Adding…", "正在加入…") : l("Add to Skill library", "加入 Skill 库")}
            </Button>
          </div>
        </form>
      ) : null}
      <section className="memory-detail-section">
        <h4>{l("Solution", "做法")}</h4>
        <p className="memory-text">{card.solution}</p>
      </section>
      {card.previousSolution ? <section className="memory-detail-section">
        <h4>{l("Previous solution", "之前的做法")}</h4>
        <p className="memory-text">{card.previousSolution}</p>
      </section> : null}
      {card.failedAttempts.length > 0 ? <section className="memory-detail-section">
        <h4>{l("Did not work", "试过无效")}</h4>
        <ul className="memory-failed">{card.failedAttempts.map((attempt) => <li key={attempt}>{attempt}</li>)}</ul>
      </section> : null}
      {card.keywords.length > 0 ? <section className="memory-detail-section">
        <h4>{l("Keywords", "关键词")}</h4>
        <p className="memory-keywords">{card.keywords.join(" · ")}</p>
      </section> : null}
      {card.sources.length > 0 ? <section className="memory-detail-section">
        <h4>{l("Sources", "来源")}</h4>
        <div className="memory-sources">
          {card.sources.map((source) => (
            <button key={`${source.sessionKey}:${source.firstTurnIndex}`} type="button" className="memory-source" title={source.sessionKey}
              onClick={() => onViewSource(source.sessionKey, source.firstTurnIndex)}>
              {turns(source.firstTurnIndex, source.lastTurnIndex)}{" · "}{new Date(source.lastTurnAt).toLocaleDateString()}
            </button>
          ))}
        </div>
      </section> : null}
    </CatalogDetail>;
  }

  return <CatalogPage
    title="Memory"
    meta={meta}
    search={<CatalogSearch value={query} onChange={setQuery} label={l("Search cards", "搜索经验卡")} placeholder={l("Search problems, solutions or keywords", "搜索问题、做法或关键词")} />}
    actions={actions}
  >
    {error ? <p role="alert" className="ui-notice ui-notice-error catalog-error">{error}</p> : null}
    {status?.lastRunError ? <p role="alert" className="ui-notice ui-notice-error catalog-error">{status.lastRunError}</p> : null}
    {statusLine || (status && status.failures.length > 0) ? <div className="memory-status">
      {statusLine ? <span>{statusLine}</span> : null}
      {status && status.failures.length > 0 ? <details className="memory-failures">
        <summary>{l(`${status.failures.length} Sessions failed`, `${status.failures.length} 个会话处理失败`)}</summary>
        <div className="memory-failures-body">
          <ul>
            {status.failures.map((failure) => (
              <li key={failure.sessionKey}>
                <span className="memory-failure-title">{failure.title}</span>
                <span className="memory-failure-error">{failure.lastError}</span>
                <span className="memory-failure-meta">
                  {failure.nextRetryAt
                    ? l(`Retries automatically after ${new Date(failure.nextRetryAt).toLocaleString()}`, `将于 ${new Date(failure.nextRetryAt).toLocaleString()} 后自动重试`)
                    : l("Stopped after repeated failures", "多次失败后已停止")}
                </span>
                <Button size="sm" disabled={busy !== null} onClick={() => void retry(failure.sessionKey)}>{l("Retry", "重试")}</Button>
              </li>
            ))}
          </ul>
          <div className="memory-failures-foot">
            <span>{l("Retried Sessions run after the next index refresh.", "重试的会话会在下次索引刷新后处理。")}</span>
            <Button size="sm" icon={<RotateCcw size={14} />} disabled={busy !== null} onClick={() => void retry(null)}>{l("Retry all", "全部重试")}</Button>
          </div>
        </div>
      </details> : null}
    </div> : null}
    <ResizableSplit className="catalog-split" label={l("Resize the list", "调整列表宽度")} storageKey="agent-recall-memory-pane" initialWidth={320} minWidth={220} maxWidth={480}>
      {list}
      <div className="catalog-detail-pane">{detail}</div>
    </ResizableSplit>
  </CatalogPage>;
}
