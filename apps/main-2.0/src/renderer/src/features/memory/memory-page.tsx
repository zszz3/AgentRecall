import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Pencil, RefreshCw, RotateCcw, Trash2 } from "lucide-react";

import { agentModelLabel } from "../../../../core/agent-model-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { ExperienceCardStatus, MemoryCard, MemoryCardEdit } from "../../../../shared/ipc/experience-cards";
import { localize, type LanguageMode } from "../../language";
import { Button, Group, Notice, PageBody, PageHeader, Row, Section, Switch } from "../../ui/primitives";
import { errorText } from "../status/status-messages";

interface MemoryPageProps {
  language: LanguageMode;
  settings: AppSettings | null;
  onSettingsChange: (update: AppSettingsUpdate) => Promise<void>;
  /** Opens Provider → AgentRecall model, where extraction's model and key are set up. */
  onOpenAgentModel: () => void;
  onViewSource: (sessionKey: string, turnIndex: number) => void;
}

interface Draft {
  id: string;
  problem: string;
  solution: string;
  failedAttempts: string;
  keywords: string;
}

/** Experience cards extracted from Sessions: extraction switch, model, progress and card management. */
export function MemoryPage({ language, settings, onSettingsChange, onOpenAgentModel, onViewSource }: MemoryPageProps): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [status, setStatus] = useState<ExperienceCardStatus | null>(null);
  const [cards, setCards] = useState<MemoryCard[]>([]);
  const [query, setQuery] = useState("");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const listRequest = useRef(0);

  const enabled = Boolean(settings?.experienceCardsEnabled);
  const model = agentModelLabel(settings?.agentModel);

  const refreshStatus = useCallback(async () => {
    setStatus(await window.sessionSearch.getExperienceCardStatus());
  }, []);

  const refreshCards = useCallback(async (nextQuery: string, nextIncludeSuperseded: boolean) => {
    const request = ++listRequest.current;
    setLoading(true);
    try {
      const result = await window.sessionSearch.listExperienceCards({ query: nextQuery, includeSuperseded: nextIncludeSuperseded });
      if (request === listRequest.current) setCards(result);
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus().catch((cause) => setError(errorText(cause)));
  }, [refreshStatus]);

  useEffect(() => {
    void refreshCards(query, includeSuperseded).catch((cause) => setError(errorText(cause)));
  }, [query, includeSuperseded, refreshCards]);

  const groups = useMemo(() => {
    const byProject = new Map<string, MemoryCard[]>();
    for (const card of cards) byProject.set(card.projectPath, [...(byProject.get(card.projectPath) ?? []), card]);
    return [...byProject.entries()];
  }, [cards]);

  async function act(key: string, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(key);
    setError(null);
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

  const save = (current: Draft) => act(`edit:${current.id}`, async () => {
    const edit: MemoryCardEdit = {
      problem: current.problem,
      solution: current.solution,
      failedAttempts: splitLines(current.failedAttempts),
      keywords: current.keywords.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
    };
    if (!edit.problem.trim() || !edit.solution.trim()) {
      throw new Error(l("Problem and solution cannot be empty.", "问题和做法不能为空。"));
    }
    const updated = await window.sessionSearch.editExperienceCard(current.id, edit);
    setCards((previous) => previous.map((card) => (card.id === updated.id ? updated : card)));
    setDraft(null);
  });

  const remove = (card: MemoryCard) => act(`delete:${card.id}`, async () => {
    if (!window.confirm(l(
      `Delete this experience card? Agents will no longer find it.\n\n${card.problem}`,
      `删除这张经验卡？删除后 Agent 将无法再搜到它。\n\n${card.problem}`,
    ))) return;
    await window.sessionSearch.deleteExperienceCard(card.id);
    setCards((previous) => previous.filter((item) => item.id !== card.id));
    await refreshStatus();
  });

  const formatTokens = (value: number | null | undefined) =>
    value === null || value === undefined ? l("Unknown", "未知") : value.toLocaleString();

  return (
    <div className="memory-page">
      <PageHeader
        title="Memory"
        description={l(
          "Experience cards extracted from your Sessions. Agents get them first when they search past Sessions.",
          "从会话中提炼的经验卡。Agent 搜索历史会话时会先看到这些卡片。",
        )}
      />
      <PageBody>
        <Section title={l("Extraction", "提炼")}>
          <Group>
            <Row
              title={l("Extract experience cards", "提炼经验卡")}
              description={l(
                "Only Turns completed after extraction is turned on are processed, at most three Sessions after each index refresh. Calls use the API quota of this model.",
                "只处理开启之后完成的轮次；每次索引刷新后最多处理 3 个会话。调用会消耗这个模型的 API 用量。",
              )}
              trailing={<Switch label={l("Extract experience cards", "提炼经验卡")} checked={enabled} disabled={!settings || busy !== null} onChange={() => void toggle()} />}
            />
            <Row
              title={l("Model", "使用的模型")}
              description={model ?? l("Not set up", "尚未设置")}
              trailing={<Button size="sm" onClick={onOpenAgentModel}>{model ? l("Change", "更换") : l("Set up", "去设置")}</Button>}
            />
            {status ? (
              <dl className="memory-stats">
                <div><dt>{l("Active cards", "有效卡片")}</dt><dd>{status.activeCards}</dd></div>
                <div><dt>{l("Sessions today", "今日处理会话")}</dt><dd>{status.processedToday}</dd></div>
                <div><dt>{l("Sessions total", "累计处理会话")}</dt><dd>{status.processedSessions}</dd></div>
                <div><dt>{l("Tokens in / out", "Token 输入 / 输出")}</dt><dd>{formatTokens(status.inputTokens)} / {formatTokens(status.outputTokens)}</dd></div>
                <div><dt>{l("State", "状态")}</dt><dd>{status.running ? l("Processing", "处理中") : enabled ? l("Waiting for new Turns", "等待新的轮次") : l("Off", "已关闭")}</dd></div>
              </dl>
            ) : null}
          </Group>
          {status?.lastRunError ? <Notice kind="error">{status.lastRunError}</Notice> : null}
          {status && status.failures.length > 0 ? (
            <div className="memory-failures">
              <div className="memory-failures-head">
                <strong>{l(`${status.failures.length} Sessions failed`, `${status.failures.length} 个会话处理失败`)}</strong>
                <Button size="sm" icon={<RotateCcw size={14} />} disabled={busy !== null} onClick={() => void retry(null)}>
                  {l("Retry all", "全部重试")}
                </Button>
              </div>
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
                    <Button size="sm" disabled={busy !== null} onClick={() => void retry(failure.sessionKey)}>
                      {l("Retry", "重试")}
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="memory-hint">{l("Retried Sessions run after the next index refresh.", "重试的会话会在下次索引刷新后处理。")}</p>
            </div>
          ) : null}
        </Section>

        <Section title={l("Experience cards", "经验卡")}>
        <div className="memory-cards-toolbar">
          <input
            type="search"
            value={query}
            placeholder={l("Search cards", "搜索经验卡")}
            aria-label={l("Search cards", "搜索经验卡")}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <label className="memory-superseded">
            <input type="checkbox" checked={includeSuperseded} onChange={(event) => setIncludeSuperseded(event.currentTarget.checked)} />
            <span>{l("Show superseded cards", "显示已被取代的卡片")}</span>
          </label>
          <button
            type="button"
            className="icon-button"
            aria-label={l("Refresh", "刷新")}
            title={l("Refresh", "刷新")}
            disabled={loading}
            onClick={() => void Promise.all([refreshStatus(), refreshCards(query, includeSuperseded)]).catch((cause) => setError(errorText(cause)))}
          ><RefreshCw size={14} /></button>
        </div>
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
        {!loading && cards.length === 0 ? (
          <p className="memory-empty">{query
            ? l("No cards match this search.", "没有匹配的经验卡。")
            : l("No experience cards yet. Cards appear after extraction processes new Sessions.", "还没有经验卡。开启提炼并产生新的会话后，这里会出现卡片。")}</p>
        ) : null}
        <div className="memory-groups">
          {groups.map(([projectPath, projectCards]) => (
            <section key={projectPath} className="memory-group" aria-label={projectPath}>
              <h3 title={projectPath}>{projectPath || l("No project", "无项目")}</h3>
              {projectCards.map((card) => (
                <article key={card.id} className={`memory-card ${card.status === "superseded" ? "superseded" : ""}`}>
                  {draft?.id === card.id ? (
                    <form className="memory-card-form" onSubmit={(event) => { event.preventDefault(); void save(draft); }}>
                      <label><span>{l("Problem", "问题")}</span><textarea value={draft.problem} onChange={(event) => setDraft({ ...draft, problem: event.currentTarget.value })} /></label>
                      <label><span>{l("Solution", "做法")}</span><textarea value={draft.solution} onChange={(event) => setDraft({ ...draft, solution: event.currentTarget.value })} /></label>
                      <label><span>{l("Failed attempts (one per line)", "试过无效的做法（每行一条）")}</span><textarea value={draft.failedAttempts} onChange={(event) => setDraft({ ...draft, failedAttempts: event.currentTarget.value })} /></label>
                      <label><span>{l("Keywords (comma separated)", "关键词（逗号分隔）")}</span><input value={draft.keywords} onChange={(event) => setDraft({ ...draft, keywords: event.currentTarget.value })} /></label>
                      <div className="memory-card-actions">
                        <button type="submit" className="settings-action-button" disabled={busy !== null}>
                          {busy === `edit:${card.id}` ? l("Saving...", "保存中...") : l("Save", "保存")}
                        </button>
                        <button type="button" className="settings-action-button" disabled={busy !== null} onClick={() => setDraft(null)}>{l("Cancel", "取消")}</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <header className="memory-card-head">
                        <span className="memory-kind">{card.kind === "decision" ? l("Decision", "决策") : l("Experience", "经验")}</span>
                        {card.status === "superseded" ? <span className="memory-kind superseded">{l("Superseded", "已被取代")}</span> : null}
                        <h4>{card.problem}</h4>
                      </header>
                      <p className="memory-solution">{card.solution}</p>
                      {card.previousSolution ? <p className="memory-previous"><strong>{l("Previous solution: ", "之前的做法：")}</strong>{card.previousSolution}</p> : null}
                      {card.failedAttempts.length > 0 ? (
                        <div className="memory-failed">
                          <strong>{l("Did not work", "试过无效")}</strong>
                          <ul>{card.failedAttempts.map((attempt) => <li key={attempt}>{attempt}</li>)}</ul>
                        </div>
                      ) : null}
                      {card.keywords.length > 0 ? <p className="memory-keywords">{card.keywords.join(" · ")}</p> : null}
                      <footer className="memory-card-foot">
                        <div className="memory-sources">
                          {card.sources.map((source) => (
                            <button
                              key={`${source.sessionKey}:${source.firstTurnIndex}`}
                              type="button"
                              className="memory-source"
                              title={source.sessionKey}
                              onClick={() => onViewSource(source.sessionKey, source.firstTurnIndex)}
                            >
                              {l("Source", "来源")} · {source.firstTurnIndex === source.lastTurnIndex
                                ? l(`Turn ${source.firstTurnIndex + 1}`, `第 ${source.firstTurnIndex + 1} 轮`)
                                : l(`Turns ${source.firstTurnIndex + 1}–${source.lastTurnIndex + 1}`, `第 ${source.firstTurnIndex + 1}–${source.lastTurnIndex + 1} 轮`)}
                              {" · "}{new Date(source.lastTurnAt).toLocaleDateString()}
                            </button>
                          ))}
                        </div>
                        <div className="memory-card-actions">
                          <button type="button" className="icon-button" aria-label={l("Edit card", "编辑卡片")} title={l("Edit card", "编辑卡片")} disabled={busy !== null}
                            onClick={() => setDraft({ id: card.id, problem: card.problem, solution: card.solution, failedAttempts: card.failedAttempts.join("\n"), keywords: card.keywords.join(", ") })}>
                            <Pencil size={14} />
                          </button>
                          <button type="button" className="icon-button" aria-label={l("Delete card", "删除卡片")} title={l("Delete card", "删除卡片")} disabled={busy !== null}
                            onClick={() => void remove(card)}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </footer>
                    </>
                  )}
                </article>
              ))}
            </section>
          ))}
        </div>
        </Section>
      </PageBody>
    </div>
  );
}

function splitLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

