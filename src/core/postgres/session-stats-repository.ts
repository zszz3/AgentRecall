import type {
  SessionDailyTokenUsage,
  SessionSource,
  SessionStats,
  SessionStatsOptions,
  SessionStatsPeriod,
  SessionStatsSummary,
  SessionStatsTrend,
  SessionStatsTrendBucket,
  SessionStatsTrendGranularity,
  TokenUsage,
} from "../types";
import type { PostgresDatabase } from "./database";

interface StatsRange {
  period: SessionStatsPeriod;
  since: number | null;
  until: number;
}

interface StatsTrendWindow {
  since: number;
  until: number;
  granularity: SessionStatsTrendGranularity;
  buckets: SessionStatsTrendBucket[];
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function timeValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizedTokenUsage(usage?: TokenUsage): TokenUsage {
  const inputTokens = numberValue(usage?.inputTokens);
  const outputTokens = numberValue(usage?.outputTokens);
  const cachedInputTokens = numberValue(usage?.cachedInputTokens);
  const reasoningOutputTokens = numberValue(usage?.reasoningOutputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens,
  };
}

function resolveStatsRange(options: SessionStatsOptions, now: number): StatsRange {
  const period = options.period ?? "today";
  if (period === "allTime") return { period, since: null, until: now };
  if (period === "today") {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return { period, since: date.getTime(), until: now };
  }
  const days = period === "thirtyDay" ? 30 : 7;
  return { period, since: now - days * 24 * 60 * 60 * 1000, until: now };
}

function resolvePreviousStatsRange(range: StatsRange): StatsRange | null {
  if (range.period === "allTime" || range.since === null) return null;
  if (range.period === "today") {
    return {
      period: range.period,
      since: range.since - 24 * 60 * 60 * 1000,
      until: range.since,
    };
  }
  const windowMs = range.until - range.since;
  return {
    period: range.period,
    since: range.since - windowMs,
    until: range.since,
  };
}

function resolveStatsTrendWindow(
  period: SessionStatsPeriod,
  now: number,
): StatsTrendWindow | null {
  if (period === "allTime") return null;
  const granularity: SessionStatsTrendGranularity = period === "today"
    ? "day"
    : period === "sevenDay"
      ? "week"
      : "month";
  const currentStart = startOfTrendBucket(now, granularity);
  const firstStart = addTrendBuckets(currentStart, granularity, -29);
  const buckets = Array.from({ length: 30 }, (_, index) => {
    const start = addTrendBuckets(firstStart, granularity, index);
    return {
      start,
      end: addTrendBuckets(start, granularity, 1) - 1,
      label: formatTrendBucketLabel(start, granularity),
      totalTokens: 0,
    };
  });
  return {
    since: buckets[0]?.start ?? currentStart,
    until: now,
    granularity,
    buckets,
  };
}

function startOfTrendBucket(
  timestamp: number,
  granularity: SessionStatsTrendGranularity,
): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  if (granularity === "week") {
    const day = date.getDay();
    date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  } else if (granularity === "month") {
    date.setDate(1);
  }
  return date.getTime();
}

function addTrendBuckets(
  timestamp: number,
  granularity: SessionStatsTrendGranularity,
  amount: number,
): number {
  const date = new Date(timestamp);
  if (granularity === "day") date.setDate(date.getDate() + amount);
  else if (granularity === "week") date.setDate(date.getDate() + amount * 7);
  else date.setMonth(date.getMonth() + amount);
  return date.getTime();
}

function formatTrendBucketLabel(
  timestamp: number,
  granularity: SessionStatsTrendGranularity,
): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  if (granularity === "month") return `${date.getFullYear()}-${month}`;
  return `${month}-${String(date.getDate()).padStart(2, "0")}`;
}

function dailyRanges(now: number): Array<Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive">> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    const start = new Date(today);
    start.setDate(today.getDate() - (6 - index));
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return { dayStart: start.getTime(), dayEndExclusive: end.getTime() };
  });
}

function emptyStatsSummary(): SessionStatsSummary {
  return {
    sessionCount: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

export class PostgresSessionStatsRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async getStats(
    options: SessionStatsOptions = {},
    now = Date.now(),
    includePrevious = true,
  ): Promise<SessionStats> {
    const range = resolveStatsRange(options, now);
    const subagentPredicate = options.excludeSubagents ? "and sessions.is_subagent = false" : "";
    const rangeValues = range.since === null
      ? []
      : [
          new Date(range.since).toISOString(),
          new Date(range.until).toISOString(),
        ];
    const sessionsSql = range.since === null
      ? `
        select source, count(*) as session_count
        from agent_recall.sessions sessions
        ${options.excludeSubagents ? "where sessions.is_subagent = false" : ""}
        group by source
      `
      : `
        with active as (
          select sessions.source, sessions.session_key
          from agent_recall.sessions sessions
          join agent_recall.session_message_events events on events.session_key = sessions.session_key
          where events.occurred_at >= $1 and events.occurred_at <= $2 ${subagentPredicate}
          union
          select sessions.source, sessions.session_key
          from agent_recall.sessions sessions
          join agent_recall.token_events events on events.session_key = sessions.session_key
          where events.occurred_at >= $1 and events.occurred_at <= $2 ${subagentPredicate}
        )
        select source, count(distinct session_key) as session_count
        from active
        group by source
      `;
    const messagesSql = range.since === null
      ? `
        select source, coalesce(sum(message_count), 0) as message_count
        from agent_recall.sessions sessions
        ${options.excludeSubagents ? "where sessions.is_subagent = false" : ""}
        group by source
      `
      : `
        select sessions.source, count(*) as message_count
        from agent_recall.session_message_events events
        join agent_recall.sessions sessions on sessions.session_key = events.session_key
        where events.occurred_at >= $1 and events.occurred_at <= $2 ${subagentPredicate}
        group by sessions.source
      `;
    const tokenWhere = [
      ...(range.since === null ? [] : ["events.occurred_at >= $1 and events.occurred_at <= $2"]),
      ...(options.excludeSubagents ? ["sessions.is_subagent = false"] : []),
    ];
    const tokensSql = `
      with ranked as (
        select
          sessions.source,
          events.dedupe_key,
          events.occurred_at,
          events.input_tokens,
          events.output_tokens,
          events.cached_input_tokens,
          events.reasoning_output_tokens,
          events.total_tokens,
          row_number() over (
            partition by events.dedupe_key
            order by
              events.total_tokens desc,
              case sessions.source
                when 'codex-cli' then 1
                when 'claude-cli' then 1
                when 'codex-app' then 2
                when 'claude-app' then 2
                else 9
              end,
              events.occurred_at
          ) as row_rank
        from agent_recall.token_events events
        join agent_recall.sessions sessions on sessions.session_key = events.session_key
        ${tokenWhere.length > 0 ? `where ${tokenWhere.join(" and ")}` : ""}
      )
      select
        source,
        coalesce(sum(input_tokens), 0) as input_tokens,
        coalesce(sum(output_tokens), 0) as output_tokens,
        coalesce(sum(cached_input_tokens), 0) as cached_input_tokens,
        coalesce(sum(reasoning_output_tokens), 0) as reasoning_output_tokens,
        coalesce(sum(total_tokens), 0) as total_tokens
      from ranked
      where row_rank = 1
      group by source
    `;
    const [sessionRows, messageRows, tokenRows] = await Promise.all([
      this.database.query<{ source: SessionSource; session_count: number | string }>(
        sessionsSql,
        rangeValues,
      ),
      this.database.query<{ source: SessionSource; message_count: number | string }>(
        messagesSql,
        rangeValues,
      ),
      this.database.query<{
        source: SessionSource;
        input_tokens: number | string;
        output_tokens: number | string;
        cached_input_tokens: number | string;
        reasoning_output_tokens: number | string;
        total_tokens: number | string;
      }>(tokensSql, rangeValues),
    ]);
    let effectiveTokenRows = tokenRows.rows;
    if (range.since === null && effectiveTokenRows.length === 0) {
      const fallback = await this.database.query<{
        source: SessionSource;
        input_tokens: number | string;
        output_tokens: number | string;
        cached_input_tokens: number | string;
        reasoning_output_tokens: number | string;
        total_tokens: number | string;
      }>(
        `
          select
            source,
            coalesce(sum(input_tokens), 0) as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens,
            coalesce(sum(cached_input_tokens), 0) as cached_input_tokens,
            coalesce(sum(reasoning_output_tokens), 0) as reasoning_output_tokens,
            coalesce(sum(total_tokens), 0) as total_tokens
          from agent_recall.sessions sessions
          ${options.excludeSubagents ? "where sessions.is_subagent = false" : ""}
          group by source
        `,
      );
      effectiveTokenRows = fallback.rows;
    }

    const summaries = new Map<SessionSource, SessionStatsSummary>();
    const getSummary = (source: SessionSource) => {
      const existing = summaries.get(source);
      if (existing) return existing;
      const created = emptyStatsSummary();
      summaries.set(source, created);
      return created;
    };
    for (const row of sessionRows.rows) getSummary(row.source).sessionCount = numberValue(row.session_count);
    for (const row of messageRows.rows) getSummary(row.source).messageCount = numberValue(row.message_count);
    for (const row of effectiveTokenRows) {
      const summary = getSummary(row.source);
      summary.inputTokens = numberValue(row.input_tokens);
      summary.outputTokens = numberValue(row.output_tokens);
      summary.cachedInputTokens = numberValue(row.cached_input_tokens);
      summary.reasoningOutputTokens = numberValue(row.reasoning_output_tokens);
      summary.totalTokens = numberValue(row.total_tokens);
    }
    const bySource = [...summaries.entries()]
      .map(([source, summary]) => ({ source, ...summary }))
      .filter((summary) => summary.sessionCount > 0 || summary.messageCount > 0 || summary.totalTokens > 0)
      .sort((left, right) => left.source.localeCompare(right.source));
    const total = bySource.reduce<SessionStatsSummary>(
      (summary, source) => ({
        sessionCount: summary.sessionCount + source.sessionCount,
        messageCount: summary.messageCount + source.messageCount,
        inputTokens: summary.inputTokens + source.inputTokens,
        outputTokens: summary.outputTokens + source.outputTokens,
        cachedInputTokens: summary.cachedInputTokens + source.cachedInputTokens,
        reasoningOutputTokens: summary.reasoningOutputTokens + source.reasoningOutputTokens,
        totalTokens: summary.totalTokens + source.totalTokens,
      }),
      emptyStatsSummary(),
    );

    const days = dailyRanges(now);
    const dailyRows = await this.database.query<{
      occurred_at: Date | string;
      input_tokens: number | string;
      output_tokens: number | string;
      cached_input_tokens: number | string;
      reasoning_output_tokens: number | string;
      total_tokens: number | string;
    }>(
      `
        with ranked as (
          select
            events.*,
            row_number() over (
              partition by events.dedupe_key
              order by events.total_tokens desc, events.occurred_at
            ) as row_rank
          from agent_recall.token_events events
          join agent_recall.sessions sessions on sessions.session_key = events.session_key
          where events.occurred_at >= $1 and events.occurred_at <= $2
            ${options.excludeSubagents ? "and sessions.is_subagent = false" : ""}
        )
        select
          occurred_at, input_tokens, output_tokens, cached_input_tokens,
          reasoning_output_tokens, total_tokens
        from ranked
        where row_rank = 1
      `,
      [
        new Date(days[0].dayStart).toISOString(),
        new Date(now).toISOString(),
      ],
    );
    const dailyTokenUsage = days.map<SessionDailyTokenUsage>((day) => {
      const usage = dailyRows.rows
        .filter((row) => {
          const timestamp = timeValue(row.occurred_at);
          return timestamp >= day.dayStart && timestamp < day.dayEndExclusive;
        })
        .reduce<TokenUsage>(
          (sum, row) => ({
            inputTokens: sum.inputTokens + numberValue(row.input_tokens),
            outputTokens: sum.outputTokens + numberValue(row.output_tokens),
            cachedInputTokens: sum.cachedInputTokens + numberValue(row.cached_input_tokens),
            reasoningOutputTokens: sum.reasoningOutputTokens + numberValue(row.reasoning_output_tokens),
            totalTokens: sum.totalTokens + numberValue(row.total_tokens),
          }),
          normalizedTokenUsage(),
        );
      return { ...day, ...usage };
    });

    const previousRange = resolvePreviousStatsRange(range);
    const previousTotal = includePrevious && previousRange
      ? (
          await this.getStats(
            { ...options, period: previousRange.period },
            previousRange.until - 1,
            false,
          )
        ).total
      : null;

    return { total, bySource, dailyTokenUsage, range, previousTotal };
  }

  async getStatsTrend(
    options: SessionStatsOptions = {},
    now = Date.now(),
  ): Promise<SessionStatsTrend> {
    const period = options.period ?? "today";
    const window = resolveStatsTrendWindow(period, now);
    if (!window) return { period, granularity: null, buckets: [] };

    const result = await this.database.query<{
      occurred_at: Date | string;
      total_tokens: number | string;
    }>(
      `
        with ranked as (
          select
            events.occurred_at,
            events.total_tokens,
            row_number() over (
              partition by events.dedupe_key
              order by
                events.total_tokens desc,
                case sessions.source
                  when 'codex-cli' then 1
                  when 'claude-cli' then 1
                  when 'codex-app' then 2
                  when 'claude-app' then 2
                  else 9
                end,
                events.occurred_at
            ) as row_rank
          from agent_recall.token_events events
          join agent_recall.sessions sessions on sessions.session_key = events.session_key
          where events.occurred_at >= $1
            and events.occurred_at <= $2
            ${options.excludeSubagents ? "and sessions.is_subagent = false" : ""}
        )
        select occurred_at, total_tokens
        from ranked
        where row_rank = 1
      `,
      [
        new Date(window.since).toISOString(),
        new Date(window.until).toISOString(),
      ],
    );

    const totals = new Map<number, number>();
    for (const row of result.rows) {
      const bucketStart = startOfTrendBucket(
        timeValue(row.occurred_at),
        window.granularity,
      );
      totals.set(
        bucketStart,
        (totals.get(bucketStart) ?? 0) + numberValue(row.total_tokens),
      );
    }

    const buckets = window.buckets.map((bucket) => ({
      ...bucket,
      totalTokens: totals.get(bucket.start) ?? 0,
    }));
    const firstNonZero = buckets.findIndex((bucket) => bucket.totalTokens > 0);
    return {
      period,
      granularity: window.granularity,
      buckets: firstNonZero === -1 ? [] : buckets.slice(firstNonZero),
    };
  }
}
