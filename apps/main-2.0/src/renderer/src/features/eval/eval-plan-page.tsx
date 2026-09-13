import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderInput,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Target,
  Trash2,
} from "lucide-react";

import type {
  AgentChannel,
  ConfiguredAgent,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRunSummary,
  EvaluationScoringConfig,
  EvaluationStageDefinition,
} from "../../../../automation/contracts";
import { localize, type LanguageMode } from "../../language";
import { judgesTrajectory } from "../../../../core/evaluation/case-graph";
import { EvalCheckDialog } from "./eval-check-editor";
import { EvalDimensionCard, type DimensionCardData } from "./eval-dimension-card";
import { dimensionsOf, methodText, type EvalDimension } from "./eval-dimensions";

/**
 * An evaluation plan: what to run, which dimensions judge it, and how they combine.
 *
 * A dimension is the unit the whole thing is read in, so it is also the unit it is
 * configured in — the cards at the top are the last run's score per dimension, and
 * the sections below are what produced them. There is no graph to draw: which step
 * feeds which follows from the dimensions' own kinds, and the engine derives it.
 */
const DEFAULT_THRESHOLD = 0.6;
/** The bound the save path enforces, so the form refuses what a save would reject. */
const MAX_STAGES = 10;

export function EvalPlanPage({
  language,
  onDirtyChange,
  onOpenRuns,
}: {
  language: LanguageMode;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenRuns?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [plans, setPlans] = useState<EvaluationExperiment[] | null>(null);
  const [datasets, setDatasets] = useState<EvaluationDataset[]>([]);
  const [evaluators, setEvaluators] = useState<EvaluationEvaluator[]>([]);
  const [agents, setAgents] = useState<ConfiguredAgent[]>([]);
  const [channels, setChannels] = useState<AgentChannel[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [runs, setRuns] = useState<EvaluationRunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EvaluationExperiment | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingCheckId, setEditingCheckId] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (keepId?: string) => {
    setError(null);
    try {
      const [nextPlans, nextDatasets, nextEvaluators, snapshot, skillSnapshot] = await Promise.all([
        window.sessionSearch.automation.listEvaluationExperiments(),
        window.sessionSearch.automation.listEvaluationDatasets(),
        window.sessionSearch.automation.listEvaluationEvaluators(),
        window.sessionSearch.automation.getSnapshot(),
        window.sessionSearch.listSkills(),
      ]);
      setPlans(nextPlans);
      setDatasets(nextDatasets);
      setEvaluators(nextEvaluators.filter((item) => item.enabled));
      setAgents(snapshot.configuredAgents);
      setChannels(snapshot.channels);
      setSkills([...new Set(skillSnapshot.skills.map((item) => item.name))].sort());
      setSelectedId((current) => {
        const wanted = keepId ?? current;
        return nextPlans.some((item) => item.id === wanted) ? wanted : nextPlans[0]?.id ?? null;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const stored = useMemo(
    () => plans?.find((item) => item.id === selectedId) ?? null,
    [plans, selectedId],
  );

  useEffect(() => {
    if (selectedId === null) return;
    setDraft(stored);
    setExpanded(null);
  }, [selectedId, stored]);

  /** The last few runs of this plan, oldest first, for the trend on each card. */
  useEffect(() => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const page = await window.sessionSearch.automation.listEvaluationRuns({
          experimentId: selectedId,
          limit: 12,
        });
        if (!cancelled) setRuns([...page.items].reverse());
      } catch {
        // A missing trend is not worth an error banner; the cards read fine without.
        if (!cancelled) setRuns([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const dirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(stored));

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const dimensions = useMemo(() => dimensionsOf(evaluators), [evaluators]);
  const scoring = draft?.scoring ?? null;

  /**
   * The dimensions this plan judges by, and the ones it does not.
   *
   * Checks are a shared library and every plan judges different things, so the
   * ones in play are listed first and the rest fold away — otherwise a library
   * grown from a dozen plans buries the handful this plan uses.
   */
  const chosen = useMemo(
    () => (draft
      ? dimensions.filter(
        (dimension) => dimension.checks.some((check) => draft.evaluatorIds.includes(check.id)),
      )
      : []),
    [dimensions, draft],
  );
  const others = useMemo(
    () => dimensions.filter((dimension) => !chosen.includes(dimension)),
    [chosen, dimensions],
  );

  const cards = useMemo<DimensionCardData[]>(() => {
    if (!draft) return [];
    return chosen.map((dimension) => ({
      dimension: dimension.name,
      score: scoreOf(runs.at(-1), dimension.name),
      weight: weightOf(scoring, dimension.name),
      ...(dimension.priority ? { priority: dimension.priority } : {}),
      threshold: scoring?.resolvedThreshold ?? DEFAULT_THRESHOLD,
      method: methodText(language, dimension),
      trend: runs.map((run) => ({
        score: scoreOf(run, dimension.name),
        startedAt: run.startedAt,
      })),
    }));
  }, [chosen, draft, language, runs, scoring]);

  const leave = useCallback(() => {
    if (!dirty) return true;
    return window.confirm(l(
      "This plan has unsaved changes. Leave them behind?",
      "这个方案有未保存的修改，要放弃吗？",
    ));
  }, [dirty, l]);

  const select = useCallback((id: string) => {
    if (id === selectedId) return;
    if (!leave()) return;
    setDraft(null);
    setSelectedId(id);
  }, [leave, selectedId]);

  const create = useCallback(async () => {
    if (!leave()) return;
    if (datasets.length === 0) {
      setError(l(
        "A plan runs the cases of a dataset. Create one on the Datasets page first.",
        "方案需要数据集提供用例，请先到「数据集」页面建一个。",
      ));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const now = Date.now();
      const created = await window.sessionSearch.automation.saveEvaluationExperiment({
        id: `eval-plan-${now}`,
        name: l("Untitled plan", "未命名方案"),
        datasetId: datasets[0]!.id,
        agentId: agents[0]?.id ?? "",
        // Nothing, to start. Every plan judges different things, so inheriting the
        // whole library would mean unpicking it before saying what this plan is
        // actually about — and adding a dimension is now one click away.
        evaluatorIds: [],
        repetitions: 1,
        source: "run_agent",
        skillName: null,
        createdAt: now,
        updatedAt: now,
      });
      await reload(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [agents, datasets, evaluators, l, leave, reload]);

  const save = useCallback(async (): Promise<EvaluationExperiment | null> => {
    if (!draft) return null;
    setSaving(true);
    setError(null);
    try {
      const saved = await window.sessionSearch.automation.saveEvaluationExperiment({
        ...draft,
        name: draft.name.trim() || l("Untitled plan", "未命名方案"),
        updatedAt: Date.now(),
      });
      await reload(saved.id);
      return saved;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setSaving(false);
    }
  }, [draft, l, reload]);

  /** Running saves first: a run belongs to a stored plan, not to a form. */
  const run = useCallback(async () => {
    const saved = await save();
    if (!saved) return;
    setRunning(true);
    setNote(null);
    try {
      await window.sessionSearch.automation.runEvaluationExperiment(saved.id);
      onOpenRuns?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }, [onOpenRuns, save]);

  const importFolder = useCallback(async () => {
    setError(null);
    setNote(null);
    try {
      const result = await window.sessionSearch.automation.importEvaluationDatasetFolder();
      // Null means the picker was dismissed, which is not a failure to report.
      if (!result) return;
      setDatasets(await window.sessionSearch.automation.listEvaluationDatasets());
      setDraft((current) => current && { ...current, datasetId: result.dataset.id });
      setNote(l(
        `Read ${result.dataset.items.length} case(s) from ${result.directory}`,
        `已从 ${result.directory} 读到 ${result.dataset.items.length} 条用例`,
      ));
      if (result.errors.length > 0) setError(result.errors.join("\n"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [l]);

  const remove = useCallback(async (target: EvaluationExperiment) => {
    setError(null);
    try {
      // Counted at the moment it matters: deleting a plan takes its runs with it.
      const page = await window.sessionSearch.automation.listEvaluationRuns({
        experimentId: target.id,
        limit: 1,
      });
      if (!window.confirm(page.total > 0
        ? l(
          `Delete "${target.name}" and its ${page.total} recorded run(s)? The runs cannot be recovered.`,
          `删除「${target.name}」以及它已记录的 ${page.total} 次运行？运行记录无法恢复。`,
        )
        : l(`Delete "${target.name}"?`, `删除「${target.name}」？`))) {
        return;
      }
      await window.sessionSearch.automation.deleteEvaluationExperiment(target.id);
      setDraft(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [l, reload]);

  /**
   * Adds a check, and takes it into this plan.
   *
   * Authoring belongs here because a plan is where you know what "good" means for
   * the thing being evaluated — sending you to another page to define a check and
   * back again to select it makes the common case the long way round. A new check
   * is selected into this plan only; other plans see it unchosen, which is what
   * keeps one rubric reusable without imposing it everywhere.
   */
  const createCheck = useCallback(async (dimension: string | null) => {
    setError(null);
    setNote(null);
    const name = dimension === null
      ? l("Untitled dimension", "未命名维度")
      : l("Untitled check", "未命名检查");
    try {
      const now = Date.now();
      const created = await window.sessionSearch.automation.saveEvaluationEvaluator({
        id: `evaluator-${now}`,
        name,
        kind: "contains",
        threshold: 0.6,
        enabled: true,
        dimension: dimension ?? name,
        createdAt: now,
        updatedAt: now,
      });
      setEvaluators((current) => [...current, created]);
      setDraft((current) => current && {
        ...current,
        evaluatorIds: [...current.evaluatorIds, created.id],
      });
      setExpanded(created.dimension ?? created.name);
      // Straight into the editor: a check called "未命名检查" that passes when the
      // answer contains nothing in particular is a placeholder, not a judgement.
      setEditingCheckId(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [l]);

  /** Choosing a dimension takes in every check it is judged by. */
  const toggleDimension = useCallback((dimension: EvalDimension, on: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const ids = new Set(current.evaluatorIds);
      for (const check of dimension.checks) {
        if (on) ids.add(check.id);
        else ids.delete(check.id);
      }
      return { ...current, evaluatorIds: [...ids] };
    });
  }, []);

  const setScoring = useCallback((patch: Partial<EvaluationScoringConfig>) => {
    setDraft((current) => current && {
      ...current,
      scoring: { ...(current.scoring ?? {}), ...patch },
    });
  }, []);

  const setWeight = useCallback((dimension: string, weight: number) => {
    setDraft((current) => {
      if (!current) return current;
      const byLabels = { ...(current.scoring?.weightByLabels ?? {}) };
      byLabels.dimension = { ...(byLabels.dimension ?? {}), [dimension]: weight };
      return { ...current, scoring: { ...(current.scoring ?? {}), weightByLabels: byLabels } };
    });
  }, []);

  const stages = draft?.stages ?? [];

  const setStages = useCallback(
    (update: (current: EvaluationStageDefinition[]) => EvaluationStageDefinition[]) => {
      setDraft((current) => current && { ...current, stages: update(current.stages ?? []) });
    },
    [],
  );

  const addStage = useCallback(() => {
    setStages((current) => [
      ...current,
      {
        id: `stage-${Date.now()}-${current.length}`,
        name: "",
        boundaryKind: "file_written",
        pattern: "",
      },
    ]);
  }, [setStages]);

  const updateStage = useCallback((id: string, patch: Partial<EvaluationStageDefinition>) => {
    setStages((current) => current.map(
      (stage) => (stage.id === id ? { ...stage, ...patch } : stage),
    ));
  }, [setStages]);

  /** The list order is the segmentation, so moving a stage changes what it means. */
  const moveStage = useCallback((index: number, delta: number) => {
    setStages((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  }, [setStages]);

  const removeStage = useCallback((id: string) => {
    setDraft((current) => {
      if (!current) return current;
      const bound: Record<string, string> = {};
      for (const [evaluatorId, stageId] of Object.entries(current.stageByEvaluatorId ?? {})) {
        if (stageId !== id) bound[evaluatorId] = stageId;
      }
      return {
        ...current,
        stages: (current.stages ?? []).filter((stage) => stage.id !== id),
        stageByEvaluatorId: bound,
      };
    });
  }, []);

  /** Which stage a check judges; empty means the whole run. */
  const setStageOf = useCallback((evaluatorId: string, stageId: string) => {
    setDraft((current) => {
      if (!current) return current;
      const bound = { ...(current.stageByEvaluatorId ?? {}) };
      if (stageId === "") delete bound[evaluatorId];
      else bound[evaluatorId] = stageId;
      return { ...current, stageByEvaluatorId: bound };
    });
  }, []);

  const dataset = datasets.find((item) => item.id === draft?.datasetId) ?? null;
  const editing = evaluators.find((item) => item.id === editingCheckId) ?? null;
  // A plan with nothing to judge by would run the agent and conclude nothing, so
  // that counts as not ready rather than as a run with no findings.
  const ready = Boolean(draft?.agentId)
    && Boolean(dataset)
    && (dataset?.items.length ?? 0) > 0
    && chosen.length > 0;

  /**
   * One dimension row, with its checks behind a chevron.
   *
   * Written as a closure rather than a component so the row keeps reading against
   * the same draft and handlers as the rest of the section; it is rendered twice,
   * once for the dimensions this plan judges by and once for the rest.
   */
  const renderDimension = (dimension: EvalDimension): ReactElement | null => {
    if (!draft) return null;
    const on = dimension.checks.some((check) => draft.evaluatorIds.includes(check.id));
    const open = expanded === dimension.name;
    const boundTo = draft.stageByEvaluatorId ?? {};
    return (
      <li key={dimension.name} className={on ? "is-on" : ""}>
        <div className="eval-plan-dimension-row">
          <label>
            <input
              type="checkbox"
              checked={on}
              onChange={(event) => toggleDimension(dimension, event.target.checked)}
            />
            <span className="eval-plan-dimension-name">{dimension.name}</span>
            {dimension.priority ? (
              <span className={`eval-dimension-priority is-${dimension.priority}`}>
                {dimension.priority === "must" ? l("must", "必须") : l("should", "应该")}
              </span>
            ) : null}
          </label>
          <span className="eval-muted">{methodText(language, dimension)}</span>
          <label className="eval-plan-weight">
            <span>{l("weight", "权重")}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={weightOf(scoring, dimension.name)}
              onChange={(event) => setWeight(
                dimension.name,
                Math.max(0, Number(event.target.value) || 0),
              )}
            />
          </label>
          <button
            type="button"
            className="eval-icon-button"
            aria-label={l("Show checks", "查看检查")}
            onClick={() => setExpanded(open ? null : dimension.name)}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        </div>
        {open ? (
          <ul className="eval-plan-checks">
            {dimension.checks.map((check) => (
              <li key={check.id}>
                {/*
                  A check is where a dimension's score actually comes from, so a
                  threshold that looks wrong is noticed here. Editing it here saves
                  a round trip through the Dimensions page.
                */}
                <button
                  type="button"
                  className="eval-plan-check-row"
                  title={l("Edit this check", "编辑这条检查")}
                  onClick={() => setEditingCheckId(check.id)}
                >
                  <span className="eval-plan-check-name">
                    {check.name || check.id}
                  </span>
                  <span className="eval-badge eval-badge-dim">
                    {methodText(language, { name: check.name, checks: [check] })}
                  </span>
                  <span className="eval-muted">
                    {l("threshold", "阈值")} {check.threshold.toFixed(2)}
                  </span>
                  {check.priority ? (
                    <span className="eval-muted">
                      {check.priority === "must" ? l("must", "必须") : l("should", "应该")}
                    </span>
                  ) : null}
                  <Pencil size={11} className="eval-plan-check-pencil" />
                </button>
                {/*
                  Beside the row rather than inside it: the row is a button that
                  opens the editor, and a select cannot be nested in one. Not
                  offered for a check that judges the trajectory — that reads one
                  aggregate over the whole run, so there is no stage to bind it to
                  yet, and offering one would be a choice that silently does
                  nothing.
                */}
                {stages.length > 0
                && draft.evaluatorIds.includes(check.id)
                && !judgesTrajectory(check) ? (
                  <label className="eval-plan-check-stage">
                    <span>{l("Stage", "阶段")}</span>
                    <select
                      value={boundTo[check.id] ?? ""}
                      onChange={(event) => setStageOf(check.id, event.target.value)}
                    >
                      <option value="">{l("the whole run", "整次运行")}</option>
                      {stages.map((stage, position) => (
                        <option key={stage.id} value={stage.id}>
                          {stage.name.trim()
                            || l(`Stage ${position + 1}`, `阶段 ${position + 1}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </li>
            ))}
            <li>
              {/*
                A second check on one dimension is averaged with the first, so
                adding one here refines the dimension rather than giving it more
                weight — which is why it belongs under the dimension, not beside it.
              */}
              <button
                type="button"
                className="eval-plan-check-add"
                disabled={saving}
                onClick={() => void createCheck(dimension.name)}
              >
                <Plus size={11} />
                {l("Another check on this dimension", "给这个维度再加一条检查")}
              </button>
            </li>
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="eval-graph-page">
      <header className="eval-graph-header">
        <h4><Target size={14} /> {l("Evaluation plans", "评测方案")}</h4>
        <div className="eval-editor-actions">
          <button type="button" className="eval-icon-button" onClick={() => void reload()}>
            <RefreshCw size={12} />{l("Refresh", "刷新")}
          </button>
        </div>
      </header>
      {note ? <p className="eval-muted">{note}</p> : null}
      {error ? <p className="eval-error" role="alert">{error}</p> : null}
      <div className="eval-graph-body">
        <aside className="eval-graph-sidebar">
          <header>
            <strong>
              {l("Plans", "方案")}
              {plans ? <small>{plans.length}</small> : null}
            </strong>
            <button
              type="button"
              className="eval-icon-button"
              aria-label={l("New plan", "新建方案")}
              title={l("New plan", "新建方案")}
              disabled={saving}
              onClick={() => void create()}
            >
              <Plus size={14} />
            </button>
          </header>
          <ul className="eval-graph-run-list">
            {plans === null ? (
              <li className="eval-muted">{l("Loading...", "加载中...")}</li>
            ) : plans.length === 0 ? (
              <li className="eval-muted">{l("No plans yet.", "还没有方案。")}</li>
            ) : plans.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`eval-graph-run-row ${item.id === selectedId ? "active" : ""}`}
                  onClick={() => select(item.id)}
                >
                  <span className="eval-graph-run-name">{item.name || item.id}</span>
                  <span className="eval-graph-run-meta">
                    {item.skillName ? (
                      <span className="eval-badge eval-badge-current">{item.skillName}</span>
                    ) : null}
                    {item.evaluatorIds.length === 0 ? (
                      <span className="eval-badge eval-badge-warn">{l("no judge", "无判定")}</span>
                    ) : (
                      <span className="eval-muted">
                        {l(
                          `${dimensionCount(dimensions, item)} dimension(s)`,
                          `${dimensionCount(dimensions, item)} 个维度`,
                        )}
                      </span>
                    )}
                  </span>
                  <small className="eval-muted">
                    {datasets.find((set) => set.id === item.datasetId)?.name ?? item.datasetId}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <div className="eval-graph-detail">
          {!draft ? (
            <p className="eval-muted">
              {plans?.length === 0
                ? l(
                  "Make a plan: pick a Runtime, the cases to run it on, and the dimensions that judge the result.",
                  "先建一个方案：选 Runtime、要跑的用例，以及判定结果的维度。",
                )
                : l("Select a plan.", "选择一个方案。")}
            </p>
          ) : (
            <>
              <div className="eval-plan-head">
                <div className="eval-plan-title">
                  <input
                    value={draft.name}
                    aria-label={l("Plan name", "方案名称")}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                  <span className="eval-muted">{planSummary(language, draft, agents, dataset)}</span>
                </div>
                <div className="eval-editor-actions">
                  {dirty ? (
                    <span className="eval-badge eval-badge-dim">{l("unsaved", "未保存")}</span>
                  ) : null}
                  <button
                    type="button"
                    className="eval-run-button"
                    disabled={!ready || running || saving}
                    title={ready ? undefined : l(
                      "Needs a Runtime, a dataset with at least one case, and a dimension to judge by.",
                      "需要先选好 Runtime、一个有用例的数据集，以及至少一个判定维度。",
                    )}
                    onClick={() => void run()}
                  >
                    <Play size={12} />{running ? l("Running...", "运行中…") : l("Run once", "跑一次")}
                  </button>
                  <button
                    type="button"
                    className="eval-icon-button"
                    disabled={saving || !dirty}
                    onClick={() => void save()}
                  >
                    {saving ? l("Saving...", "保存中…") : dirty ? l("Save", "保存") : l("Saved", "已保存")}
                  </button>
                  <button
                    type="button"
                    className="eval-icon-button"
                    aria-label={l("Delete plan", "删除方案")}
                    onClick={() => void remove(draft)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              {cards.length > 0 ? (
                <div className="eval-dimension-cards">
                  {cards.map((card) => (
                    <EvalDimensionCard key={card.dimension} language={language} data={card} />
                  ))}
                </div>
              ) : (
                <p className="eval-muted">
                  {l(
                    "No dimension chosen yet, so a run would conclude nothing.",
                    "还没有选任何维度，这样跑起来不会有结论。",
                  )}
                </p>
              )}

              <section className="eval-plan-section">
                <h5>{l("What to run", "跑什么")}</h5>
                <div className="eval-field">
                  <div className="eval-field-text">
                    <span className="eval-field-title">Runtime</span>
                    <span className="eval-field-sub">
                      {l("Runs every case once. Required.", "逐条跑完每个用例。必填。")}
                    </span>
                  </div>
                  <select
                    value={draft.agentId}
                    onChange={(event) => setDraft({ ...draft, agentId: event.target.value })}
                  >
                    <option value="">{l("(pick a Runtime)", "（选择 Runtime）")}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                  </select>
                </div>
                <div className="eval-field">
                  <div className="eval-field-text">
                    <span className="eval-field-title">Skill</span>
                    <span className="eval-field-sub">
                      {l(
                        "Optional. Its instructions go to the model with each task.",
                        "可选。它的说明会随每个任务一起交给模型。",
                      )}
                    </span>
                  </div>
                  <select
                    value={draft.skillName ?? ""}
                    onChange={(event) => setDraft({
                      ...draft,
                      skillName: event.target.value === "" ? null : event.target.value,
                    })}
                  >
                    <option value="">{l("(inject nothing)", "（不注入）")}</option>
                    {skills.map((skill) => (
                      <option key={skill} value={skill}>{skill}</option>
                    ))}
                  </select>
                </div>
                <div className="eval-field">
                  <div className="eval-field-text">
                    <span className="eval-field-title">{l("Cases", "数据集")}</span>
                    <span className="eval-field-sub">
                      {dataset
                        ? l(`${dataset.items.length} case(s).`, `${dataset.items.length} 条用例。`)
                        : l(
                          "The cases to run. Pick one, or point at a folder of cases on disk.",
                          "要跑的用例。选一个，或指向磁盘上的一个用例目录。",
                        )}
                    </span>
                  </div>
                  <div className="eval-field-control">
                    <select
                      value={draft.datasetId}
                      onChange={(event) => setDraft({ ...draft, datasetId: event.target.value })}
                    >
                      <option value="">{l("(pick a dataset)", "（选择数据集）")}</option>
                      {datasets.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name || item.id} · {item.items.length}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="eval-icon-button" onClick={() => void importFolder()}>
                      <FolderInput size={12} />{l("Folder...", "选目录…")}
                    </button>
                  </div>
                </div>
                <div className="eval-field">
                  <div className="eval-field-text">
                    <span className="eval-field-title">{l("Repetitions", "重复次数")}</span>
                    <span className="eval-field-sub">
                      {l(
                        "Runs each case more than once, to see how much the result varies.",
                        "每个用例多跑几次，用来看结果的波动。",
                      )}
                    </span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={draft.repetitions}
                    onChange={(event) => setDraft({
                      ...draft,
                      repetitions: Math.max(1, Math.min(5, Number(event.target.value) || 1)),
                    })}
                  />
                </div>
              </section>

              <section className="eval-plan-section">
                <div className="eval-plan-section-head">
                  <h5>{l("Dimensions", "维度")}</h5>
                  <button
                    type="button"
                    className="eval-icon-button"
                    disabled={saving}
                    title={l(
                      "A new dimension, judged by one new check, taken into this plan.",
                      "新建一个维度，带一条新检查，并加入本方案。",
                    )}
                    onClick={() => void createCheck(null)}
                  >
                    <Plus size={12} />{l("New dimension", "新建维度")}
                  </button>
                </div>
                {chosen.length === 0 && others.length === 0 ? (
                  <p className="eval-muted">
                    {l(
                      "Nothing judges this plan yet. Add a dimension to say what \"good\" means here.",
                      "这个方案还没有任何判定。加一个维度，说明这里什么算「好」。",
                    )}
                  </p>
                ) : null}
                {chosen.length > 0 ? (
                  <ul className="eval-plan-dimensions">
                    {chosen.map((dimension) => renderDimension(dimension))}
                  </ul>
                ) : null}
                {others.length > 0 ? (
                  <>
                    {/*
                      Dimensions this plan does not judge by are folded away. Every
                      plan judges different things, so an unfiltered library grows
                      into a list where the handful that matter are hard to find.
                    */}
                    <button
                      type="button"
                      className="eval-plan-others-toggle"
                      onClick={() => setShowOthers(!showOthers)}
                    >
                      {showOthers ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      {l(
                        `${others.length} dimension(s) defined elsewhere`,
                        `另有 ${others.length} 个已定义的维度`,
                      )}
                    </button>
                    {showOthers ? (
                      <ul className="eval-plan-dimensions is-muted">
                        {others.map((dimension) => renderDimension(dimension))}
                      </ul>
                    ) : null}
                  </>
                ) : null}
              </section>

              <section className="eval-plan-section">
                <h5>{l("How it is scored", "怎么算分")}</h5>
                <div className="eval-field">
                  <div className="eval-field-text">
                    <span className="eval-field-title">{l("Pass threshold", "通过分数线")}</span>
                    <span className="eval-field-sub">
                      {l(
                        "The weighted score a case has to reach to count as passed.",
                        "用例的加权总分要达到多少才算通过。",
                      )}
                    </span>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={scoring?.resolvedThreshold ?? DEFAULT_THRESHOLD}
                    onChange={(event) => setScoring({
                      resolvedThreshold: clamp01(Number(event.target.value)),
                    })}
                  />
                </div>
                <div className="eval-field">
                  <div className="eval-field-text">
                    <span className="eval-field-title">{l("Minimum coverage", "最低覆盖率")}</span>
                    <span className="eval-field-sub">
                      {l(
                        "Below this, a case cannot pass however high it scored — too little of the rubric was actually judged.",
                        "低于这个比例即使分数很高也不算通过 —— 说明计划中的判定实际上没判到多少。",
                      )}
                    </span>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={scoring?.minCoverage ?? 0}
                    onChange={(event) => setScoring({ minCoverage: clamp01(Number(event.target.value)) })}
                  />
                </div>
                <div className="eval-field">
                  <div className="eval-field-text">
                    <span className="eval-field-title">{l("Undecided verdicts", "判不出来的")}</span>
                    <span className="eval-field-sub">
                      {l(
                        "A judge that answered without deciding. Excluding it keeps a broken judge out of the score; counting it as zero is stricter.",
                        "评判器答了但没给出结论。排除表示不让它影响分数；计 0 更严格。",
                      )}
                    </span>
                  </div>
                  <select
                    value={scoring?.uncertain ?? "exclude"}
                    onChange={(event) => setScoring({
                      uncertain: event.target.value === "zero" ? "zero" : "exclude",
                    })}
                  >
                    <option value="exclude">{l("exclude", "排除")}</option>
                    <option value="zero">{l("count as zero", "计 0 分")}</option>
                  </select>
                </div>
              </section>

              <section className="eval-plan-section">
                <h5>{l("Stages", "阶段")}</h5>
                <p className="eval-muted">
                  {l(
                    "A run is cut into these stages in order. Each one opens at the first file written that matches its pattern, and is only looked for after the stage before it opened — so the order here is the segmentation. A stage whose pattern never matches is reported as not found, not scored.",
                    "一次运行按这里的顺序被切成若干阶段。每个阶段从「首次写入命中其匹配模式的文件」那一刻开始，且只在它前一个阶段开始之后才搜索——所以这里的顺序就是切分方式。匹配不到的阶段会报「阶段未识别」，不计入评分。",
                  )}
                </p>
                <p className="eval-muted">
                  {l(
                    "A stage owns everything from where it opens to where the next one opens, and the last one runs to the end of the run. A check bound to a stage under Dimensions judges only that stretch: the files the stage handed on, and what the model said along the way. A stage whose pattern never matches costs only the checks bound to it, which are reported as undecided rather than scored.",
                    "一个阶段管的是从它开始到下一个阶段开始之间的全部内容，最后一个阶段一直到运行结束。在「维度」里挂到某个阶段上的检查，评的就只有这一段：这个阶段交出去的文件，以及期间模型说的话。匹配不到的阶段只影响挂在它上面的检查，那些检查会报成没判出来，不计入评分。",
                  )}
                </p>
                {draft?.source === "folder" ? (
                  <p className="eval-muted">
                    {l(
                      "This plan evaluates a folder, which has no session behind it, so there is no run to cut: its stages come back reported as skipped.",
                      "这个方案评测的是产物文件夹，背后没有会话，也就没有可切的运行：它声明的阶段会被报成「已跳过」。",
                    )}
                  </p>
                ) : null}
                <ol className="eval-stage-list">
                  {stages.map((stage, index) => (
                    <li key={stage.id}>
                      <header>
                        <span className="eval-graph-case-title">
                          {l(`Stage ${index + 1}`, `阶段 ${index + 1}`)}
                        </span>
                        <span className="eval-stage-move">
                          <button
                            type="button"
                            className="eval-icon-button"
                            disabled={index === 0}
                            onClick={() => moveStage(index, -1)}
                            aria-label={l("Move earlier", "前移")}
                          >
                            <ChevronUp size={11} />
                          </button>
                          <button
                            type="button"
                            className="eval-icon-button"
                            disabled={index === stages.length - 1}
                            onClick={() => moveStage(index, 1)}
                            aria-label={l("Move later", "后移")}
                          >
                            <ChevronDown size={11} />
                          </button>
                          <button
                            type="button"
                            className="eval-icon-button"
                            onClick={() => removeStage(stage.id)}
                            aria-label={l("Remove stage", "删除阶段")}
                          >
                            <Trash2 size={11} />
                          </button>
                        </span>
                      </header>
                      <label className="eval-editor-field">
                        <span>{l("Name", "名字")}</span>
                        <input
                          value={stage.name}
                          placeholder={l("data collection", "数据采集")}
                          onChange={(event) => updateStage(stage.id, { name: event.target.value })}
                        />
                      </label>
                      <label className="eval-editor-field">
                        <span>
                          {l("Opens when this file is first written", "首次写入这个文件时开始")}
                        </span>
                        <input
                          value={stage.pattern}
                          placeholder="report.md"
                          spellCheck={false}
                          onChange={(event) => updateStage(stage.id, { pattern: event.target.value })}
                        />
                      </label>
                    </li>
                  ))}
                </ol>
                <button
                  type="button"
                  className="eval-icon-button"
                  disabled={stages.length >= MAX_STAGES}
                  onClick={addStage}
                >
                  <Plus size={12} />{l("Add stage", "添加阶段")}
                </button>
              </section>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <EvalCheckDialog
          language={language}
          check={editing}
          channels={channels}
          onClose={() => setEditingCheckId(null)}
          onSaved={(saved) => {
            // The plan reads dimensions off the checks, so a renamed dimension or
            // a changed kind has to land in this page's own list too.
            setEvaluators((current) => current.map(
              (item) => (item.id === saved.id ? saved : item),
            ));
            setExpanded(saved.dimension?.trim() || saved.name.trim() || saved.id);
            setEditingCheckId(null);
          }}
          onDeleted={(id) => {
            setEvaluators((current) => current.filter((item) => item.id !== id));
            setDraft((current) => current && {
              ...current,
              evaluatorIds: current.evaluatorIds.filter((item) => item !== id),
            });
            setEditingCheckId(null);
          }}
        />
      ) : null}
    </div>
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function weightOf(scoring: EvaluationScoringConfig | null, dimension: string): number {
  const weight = scoring?.weightByLabels?.dimension?.[dimension];
  return typeof weight === "number" ? weight : 1;
}

/** This dimension's score in one run, or null when it decided nothing there. */
function scoreOf(run: EvaluationRunSummary | undefined, dimension: string): number | null {
  return run?.dimensions?.find((item) => item.dimension === dimension)?.score ?? null;
}

function dimensionCount(
  dimensions: readonly EvalDimension[],
  plan: EvaluationExperiment,
): number {
  return dimensions.filter(
    (dimension) => dimension.checks.some((check) => plan.evaluatorIds.includes(check.id)),
  ).length;
}

/** What this plan runs, in one line under its name. */
function planSummary(
  language: LanguageMode,
  plan: EvaluationExperiment,
  agents: readonly ConfiguredAgent[],
  dataset: EvaluationDataset | null,
): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return [
    agents.find((agent) => agent.id === plan.agentId)?.name ?? l("no Runtime", "未选 Runtime"),
    plan.skillName ?? l("no Skill", "不注入 Skill"),
    dataset
      ? l(`${dataset.items.length} case(s)`, `${dataset.items.length} 条用例`)
      : l("no cases", "未选用例"),
    plan.repetitions > 1
      ? l(`${plan.repetitions} repetitions`, `重复 ${plan.repetitions} 次`)
      : null,
  ].filter(Boolean).join(" · ");
}
