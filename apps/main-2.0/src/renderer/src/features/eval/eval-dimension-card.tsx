import type { ReactElement } from "react";

import { localize, type LanguageMode } from "../../language";

/**
 * One dimension, as a card.
 *
 * A dimension is the unit an evaluation is read in: it carries its own score, and
 * dimensions combine by weight rather than by counting checks. So the card is what
 * the ring and the trend belong to.
 *
 * Three readings, kept apart by colour the same way step statuses are: met (green),
 * unmet (red), and nothing decided (grey). The last one matters most — a dimension
 * whose judge could not decide has no score, and painting that red would blame the
 * model for the evaluation's own gap.
 */

const RING_SIZE = 54;
const RING_STROKE = 5;
const TREND_SLOTS = 6;

export interface DimensionCardData {
  dimension: string;
  /** Weighted mean of this dimension's checks; null when nothing was decided. */
  score: number | null;
  weight: number;
  /**
   * Share this dimension actually held, when a stage split its weight over the
   * dimensions judging it. Absent when it counted as declared.
   */
  effectiveWeight?: number;
  /** Id of the stage this dimension judges; absent means the whole run. */
  stage?: string;
  priority?: "must" | "should";
  /** Score a check in this dimension has to reach. */
  threshold?: number;
  /** How this dimension decides, in words: "LLM"、"脚本"、"LLM · 脚本 2 条". */
  method?: string;
  /** Oldest first; a null score means this run decided nothing. */
  trend?: Array<{ score: number | null; startedAt?: number }>;
}

export function EvalDimensionCard({
  language,
  data,
  selected,
  onClick,
}: {
  language: LanguageMode;
  data: DimensionCardData;
  selected?: boolean;
  onClick?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const state = dimensionState(data);
  const applied = data.effectiveWeight ?? data.weight;
  const body = (
    <>
      <header>
        <span className="eval-dimension-card-name">{data.dimension}</span>
        {data.priority ? (
          <span className={`eval-dimension-priority is-${data.priority}`}>
            {data.priority === "must" ? l("must", "必须") : l("should", "应该")}
          </span>
        ) : null}
        {applied !== 1 || data.weight !== 1 ? (
          <span
            className="eval-dimension-card-weight"
            title={applied === data.weight
              ? l(
                `Counts ${formatWeight(applied)} times when dimensions are combined into the total score.`,
                `汇总总分时按普通维度的 ${formatWeight(applied)} 倍计入。`,
              )
              : l(
                `Declared ${formatWeight(data.weight)}, but the dimensions judging this stage share it, so this one counts ${formatWeight(applied)} times.`,
                `声明的是 ${formatWeight(data.weight)}，但同一阶段的维度平分这份权重，所以这个维度按 ${formatWeight(applied)} 倍计入。`,
              )}
          >
            {l(`weight ${formatWeight(applied)}`, `权重 ${formatWeight(applied)}`)}
          </span>
        ) : null}
      </header>
      <ScoreRing score={data.score} state={state} />
      <span className="eval-dimension-card-method">
        {data.score === null
          ? l("not decided", "未判定")
          : data.method ?? l("judged", "已判定")}
      </span>
      {data.trend ? (
        <Trend
          language={language}
          trend={data.trend}
          threshold={data.threshold ?? 0.6}
        />
      ) : null}
    </>
  );
  const className = `eval-dimension-card is-${state} ${selected ? "is-selected" : ""}`;
  return onClick
    ? (
      <button
        type="button"
        className={className}
        aria-pressed={selected ?? false}
        onClick={onClick}
      >
        {body}
      </button>
    )
    : <div className={className}>{body}</div>;
}

/** met / unmet / undecided — the three things a dimension can be. */
export function dimensionState(data: DimensionCardData): "met" | "unmet" | "undecided" {
  if (data.score === null) return "undecided";
  return data.score >= (data.threshold ?? 0.6) ? "met" : "unmet";
}

/** One group of stage-tagged items, in the order the groups are read. */
export interface DimensionGroup<T> {
  key: string;
  /** Absent for a group that is not one declared stage, which gets no heading. */
  label?: string;
  /**
   * The stage this group is, when it is exactly one. Absent for the whole-run
   * group and for the bucket of stages the plan has dropped, neither of which has
   * a single total to show.
   */
  stage?: string;
  items: T[];
}

/**
 * Groups stage-tagged items for display.
 *
 * Order: the items that judge the whole run first and with no heading — they are
 * not a stage, and heading them would invent a group the plan never declared.
 * Then the plan's stages in the order it declares them. Then everything tagged
 * with a stage the plan no longer declares, under one heading and never by id: an
 * older run still has scores for a stage that was since dropped, and folding them
 * into the whole run would claim those dimensions judged something they did not.
 */
export function dimensionGroups<T>(
  language: LanguageMode,
  items: readonly T[],
  stageOf: (item: T) => string | undefined,
  declared: ReadonlyArray<{ id: string; name: string }>,
): Array<DimensionGroup<T>> {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const named = declared.map((stage, position) => ({
    id: stage.id,
    label: stage.name.trim() || l(`Stage ${position + 1}`, `阶段 ${position + 1}`),
  }));
  const groups: Array<DimensionGroup<T>> = [];
  const whole = items.filter((item) => stageOf(item) === undefined);
  if (whole.length > 0) groups.push({ key: "run", items: whole });
  for (const stage of named) {
    const inStage = items.filter((item) => stageOf(item) === stage.id);
    if (inStage.length > 0) {
      groups.push({ key: stage.id, label: stage.label, stage: stage.id, items: inStage });
    }
  }
  const gone = items.filter((item) => {
    const stage = stageOf(item);
    return stage !== undefined && !named.some((entry) => entry.id === stage);
  });
  if (gone.length > 0) {
    groups.push({
      key: "gone",
      label: l("A stage this plan no longer declares", "方案已不再声明的阶段"),
      items: gone,
    });
  }
  return groups;
}

/**
 * The same cards, split by the stage they judge.
 *
 * A run cut into stages reads as those stages rather than as one wall of
 * dimensions, and that a stage's dimensions share its weight is only visible
 * when they are seen side by side.
 */
export function EvalDimensionCards({
  language,
  cards,
  stages = [],
  selected,
  onSelect,
}: {
  language: LanguageMode;
  cards: readonly DimensionCardData[];
  /** The plan's declared stages, whose order is the order of the groups. */
  stages?: ReadonlyArray<{ id: string; name: string }>;
  selected?: string | null;
  onSelect?: (dimension: string) => void;
}): ReactElement {
  const groups = dimensionGroups(language, cards, (card) => card.stage, stages);
  return (
    <div className="eval-dimension-groups">
      {groups.map((group) => (
        <section key={group.key} className="eval-dimension-group">
          {group.label
            ? <h6 className="eval-dimension-group-name">{group.label}</h6>
            : null}
          <div className="eval-dimension-cards">
            {group.items.map((card) => (
              <EvalDimensionCard
                key={card.dimension}
                language={language}
                data={card}
                selected={selected === card.dimension}
                onClick={onSelect ? () => onSelect(card.dimension) : undefined}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** A declared weight is usually whole; a stage's split of one usually is not. */
function formatWeight(weight: number): string {
  return Number.isInteger(weight) ? String(weight) : weight.toFixed(2);
}

function ScoreRing({
  score,
  state,
}: {
  score: number | null;
  state: "met" | "unmet" | "undecided";
}): ReactElement {
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      className="eval-dimension-ring"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
    >
      <circle
        className="eval-dimension-ring-track"
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={radius}
        strokeWidth={RING_STROKE}
      />
      {/*
        No arc at all when nothing was decided: a zero-length arc would read as a
        score of zero, which is the one thing an undecided dimension is not.
      */}
      {score === null ? null : (
        <circle
          className="eval-dimension-ring-value"
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          strokeWidth={RING_STROKE}
          strokeDasharray={`${circumference * Math.max(0, Math.min(1, score))} ${circumference}`}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
      )}
      <text className="eval-dimension-ring-text" x="50%" y="50%" data-state={state}>
        {score === null ? "—" : score.toFixed(2).replace(/^0/, "")}
      </text>
    </svg>
  );
}

/**
 * The last few runs of this dimension.
 *
 * A run in which the dimension decided nothing gets an empty slot rather than
 * being skipped: dropping it would slide an older score into its place and read as
 * "it scored low then", when in fact it was never judged.
 */
function Trend({
  language,
  trend,
  threshold,
}: {
  language: LanguageMode;
  trend: ReadonlyArray<{ score: number | null; startedAt?: number }>;
  threshold: number;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const slots = trend.slice(-TREND_SLOTS);
  const padding = Array.from<{ score: number | null; startedAt?: number } | undefined>({
    length: Math.max(0, TREND_SLOTS - slots.length),
  });
  return (
    <div className="eval-dimension-trend-block">
      <span className="eval-dimension-trend-label">{l("Last 6 runs", "最近 6 次运行")}</span>
      <ul className="eval-dimension-trend" aria-label={l("Scores from the last 6 runs", "最近 6 次运行得分")}>
        {[...padding, ...slots].map((point, index) => {
          const score = point?.score;
          const state = score === null || score === undefined
            ? "empty"
            : score >= threshold ? "met" : "unmet";
          let title: string;
          if (point === undefined) {
            title = l("No earlier run", "暂无更早运行");
          } else if (point.score === null) {
            title = `${formatTrendTime(language, point.startedAt)} · ${l("not decided", "未判定")}`;
          } else {
            title = `${formatTrendTime(language, point.startedAt)} · ${l("score", "得分")} ${point.score.toFixed(2)} · ${state === "met" ? l("met", "达标") : l("unmet", "未达标")}`;
          }
          return (
            <li key={index} className={`is-${state}`} title={title}>
              <span
                style={score === null || score === undefined
                  ? undefined
                  : { height: `${Math.max(6, Math.min(100, score * 100))}%` }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatTrendTime(language: LanguageMode, startedAt?: number): string {
  if (startedAt === undefined) return localize(language, "run", "该次运行");
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(startedAt);
}
