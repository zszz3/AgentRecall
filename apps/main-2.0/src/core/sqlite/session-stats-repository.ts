import type { SQLInputValue } from "node:sqlite";
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
} from "../types";
import type { SqliteDatabase } from "./database";
import {
  normalizedTokenUsage,
  numberValue,
  sqliteSessionOriginPredicate,
  timeValue,
} from "./session-records";

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
    const since = new Date(range.since);
    since.setDate(since.getDate() - 1);
    const until = new Date(range.until);
    until.setDate(until.getDate() - 1);
    return { period: range.period, since: since.getTime(), until: until.getTime() };
  }
  const until = range.since - 1;
  return {
    period: range.period,
    since: until - (range.until - range.since),
    until,
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

function dailyRanges(now: number, count: number): Array<Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive">> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(today);
    start.setDate(today.getDate() - (count - 1 - index));
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

export class SqliteSessionStatsRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async getStats(
    options: SessionStatsOptions = {},
    now = Date.now(),
  ): Promise<SessionStats> {
    const range = resolveStatsRange(options, now);
    const originPredicate = sqliteSessionOriginPredicate(options.origin);
    const sessionPredicates = [
      ...(options.excludeSubagents ? ["sessions.is_subagent = 0"] : []),
      ...(originPredicate ? [originPredicate] : []),
    ];
    const { total, bySource } = this.aggregateStatsForRange(range, sessionPredicates);
    const sessionAnd = sessionPredicates.map((predicate) => `and ${predicate}`).join(" ");

    const historyDays = options.dailyHistoryDays === 30
      || options.dailyHistoryDays === 90
      || options.dailyHistoryDays === 180
      || options.dailyHistoryDays === 365
      ? options.dailyHistoryDays
      : 7;
    const days = dailyRanges(now, historyDays);
    const dayBucketPayload = JSON.stringify(
      days.map((day, index) => [index, day.dayStart, day.dayEndExclusive]),
    );
    const dailyRows = this.database.all<{
      bucket_index: number;
      input_tokens: number | string;
      output_tokens: number | string;
      cached_input_tokens: number | string;
      cache_creation_input_tokens: number | string;
      reasoning_output_tokens: number | string;
      total_tokens: number | string;
    }>(
      `
        with day_buckets as (
          select
            cast(json_extract(value, '$[0]') as integer) as bucket_index,
            cast(json_extract(value, '$[1]') as integer) as day_start,
            cast(json_extract(value, '$[2]') as integer) as day_end
          from json_each(?)
        ),
        ranked as (
          select
            events.occurred_at,
            events.input_tokens,
            events.output_tokens,
            events.cached_input_tokens,
            events.cache_creation_input_tokens,
            events.reasoning_output_tokens,
            events.total_tokens,
            row_number() over (
              partition by events.dedupe_key
              order by events.total_tokens desc, events.occurred_at
            ) as row_rank
          from token_events events
          join local_sessions sessions on sessions.session_key = events.session_key
          where events.occurred_at >= ? and events.occurred_at <= ?
            ${sessionAnd}
        )
        select
          buckets.bucket_index,
          sum(ranked.input_tokens) as input_tokens,
          sum(ranked.output_tokens) as output_tokens,
          sum(ranked.cached_input_tokens) as cached_input_tokens,
          sum(max(ranked.cache_creation_input_tokens, 0)) as cache_creation_input_tokens,
          sum(ranked.reasoning_output_tokens) as reasoning_output_tokens,
          sum(ranked.total_tokens) as total_tokens
        from ranked
        join day_buckets buckets
          on ranked.occurred_at >= buckets.day_start
         and ranked.occurred_at < buckets.day_end
        where ranked.row_rank = 1
        group by buckets.bucket_index
      `,
      dayBucketPayload,
      days[0].dayStart,
      Math.trunc(now),
    );

    const dailyTotals = new Map(days.map((day) => [day.dayStart, normalizedTokenUsage()]));
    for (const row of dailyRows) {
      const day = days[row.bucket_index];
      const usage = day ? dailyTotals.get(day.dayStart) : undefined;
      if (!usage) continue;
      usage.inputTokens += numberValue(row.input_tokens);
      usage.outputTokens += numberValue(row.output_tokens);
      usage.cachedInputTokens += numberValue(row.cached_input_tokens);
      const cacheCreated = numberValue(row.cache_creation_input_tokens);
      if (cacheCreated > 0) usage.cacheCreationInputTokens = (usage.cacheCreationInputTokens ?? 0) + cacheCreated;
      usage.reasoningOutputTokens += numberValue(row.reasoning_output_tokens);
      usage.totalTokens += numberValue(row.total_tokens);
    }
    const dailyTokenUsage = days.map<SessionDailyTokenUsage>((day) => ({
      ...day,
      ...dailyTotals.get(day.dayStart)!,
    }));

    const previousRange = resolvePreviousStatsRange(range);
    const previousTotal = previousRange
      ? this.aggregateStatsForRange(previousRange, sessionPredicates).total
      : null;

    return { total, bySource, dailyTokenUsage, range, previousTotal };
  }

  private aggregateStatsForRange(
    range: StatsRange,
    sessionPredicates: readonly string[],
  ): Pick<SessionStats, "total" | "bySource"> {
    const sessionWhere = sessionPredicates.length > 0
      ? `where ${sessionPredicates.join(" and ")}`
      : "";
    const sessionAnd = sessionPredicates.map((predicate) => `and ${predicate}`).join(" ");
    const since = range.since === null ? null : Math.trunc(range.since);
    const until = Math.trunc(range.until);

    const sessionRows = since === null
      ? this.database.all<{ source: SessionSource; session_count: number | string }>(
          `
            select source, count(*) as session_count
            from local_sessions sessions
            ${sessionWhere}
            group by source
          `,
        )
      : this.database.all<{ source: SessionSource; session_count: number | string }>(
          `
            with active as (
              select sessions.source, sessions.session_key
              from local_sessions sessions
              join session_message_events events on events.session_key = sessions.session_key
              where events.occurred_at >= ? and events.occurred_at <= ? ${sessionAnd}
              union
              select sessions.source, sessions.session_key
              from local_sessions sessions
              join token_events events on events.session_key = sessions.session_key
              where events.occurred_at >= ? and events.occurred_at <= ? ${sessionAnd}
            )
            select source, count(distinct session_key) as session_count
            from active
            group by source
          `,
          since,
          until,
          since,
          until,
        );

    const messageRows = since === null
      ? this.database.all<{ source: SessionSource; message_count: number | string }>(
          `
            select source, coalesce(sum(message_count), 0) as message_count
            from local_sessions sessions
            ${sessionWhere}
            group by source
          `,
        )
      : this.database.all<{ source: SessionSource; message_count: number | string }>(
          `
            select sessions.source, count(*) as message_count
            from session_message_events events
            join local_sessions sessions on sessions.session_key = events.session_key
            where events.occurred_at >= ? and events.occurred_at <= ? ${sessionAnd}
            group by sessions.source
          `,
          since,
          until,
        );

    const tokenWhere = [
      ...(since === null ? [] : ["events.occurred_at >= ? and events.occurred_at <= ?"]),
      ...sessionPredicates,
    ];
    const tokenParams: SQLInputValue[] = since === null ? [] : [since, until];
    let effectiveTokenRows = this.database.all<{
      source: SessionSource;
      input_tokens: number | string;
      output_tokens: number | string;
      cached_input_tokens: number | string;
      cache_creation_input_tokens: number | string;
      reasoning_output_tokens: number | string;
      total_tokens: number | string;
    }>(
      `
        with ranked as (
          select
            sessions.source,
            events.dedupe_key,
            events.occurred_at,
            events.input_tokens,
            events.output_tokens,
            events.cached_input_tokens,
            events.cache_creation_input_tokens,
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
          from token_events events
          join local_sessions sessions on sessions.session_key = events.session_key
          ${tokenWhere.length > 0 ? `where ${tokenWhere.join(" and ")}` : ""}
        )
        select
          source,
          coalesce(sum(input_tokens), 0) as input_tokens,
          coalesce(sum(output_tokens), 0) as output_tokens,
          coalesce(sum(cached_input_tokens), 0) as cached_input_tokens,
          coalesce(sum(cache_creation_input_tokens), 0) as cache_creation_input_tokens,
          coalesce(sum(reasoning_output_tokens), 0) as reasoning_output_tokens,
          coalesce(sum(total_tokens), 0) as total_tokens
        from ranked
        where row_rank = 1
        group by source
      `,
      ...tokenParams,
    );

    if (since === null && effectiveTokenRows.length === 0) {
      effectiveTokenRows = this.database.all<{
        source: SessionSource;
        input_tokens: number | string;
        output_tokens: number | string;
        cached_input_tokens: number | string;
        cache_creation_input_tokens: number | string;
        reasoning_output_tokens: number | string;
        total_tokens: number | string;
      }>(
        `
          select
            source,
            coalesce(sum(input_tokens), 0) as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens,
            coalesce(sum(cached_input_tokens), 0) as cached_input_tokens,
            coalesce(sum(cache_creation_input_tokens), 0) as cache_creation_input_tokens,
            coalesce(sum(reasoning_output_tokens), 0) as reasoning_output_tokens,
            coalesce(sum(total_tokens), 0) as total_tokens
          from local_sessions sessions
          ${sessionWhere}
          group by source
        `,
      );
    }

    const summaries = new Map<SessionSource, SessionStatsSummary>();
    const getSummary = (source: SessionSource) => {
      const existing = summaries.get(source);
      if (existing) return existing;
      const created = emptyStatsSummary();
      summaries.set(source, created);
      return created;
    };
    for (const row of sessionRows) getSummary(row.source).sessionCount = numberValue(row.session_count);
    for (const row of messageRows) getSummary(row.source).messageCount = numberValue(row.message_count);
    for (const row of effectiveTokenRows) {
      const summary = getSummary(row.source);
      summary.inputTokens = numberValue(row.input_tokens);
      summary.outputTokens = numberValue(row.output_tokens);
      summary.cachedInputTokens = numberValue(row.cached_input_tokens);
      if (numberValue(row.cache_creation_input_tokens) > 0) {
        summary.cacheCreationInputTokens = numberValue(row.cache_creation_input_tokens);
      }
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
        ...((summary.cacheCreationInputTokens ?? 0) + (source.cacheCreationInputTokens ?? 0) > 0
          ? { cacheCreationInputTokens: (summary.cacheCreationInputTokens ?? 0) + (source.cacheCreationInputTokens ?? 0) }
          : {}),
        reasoningOutputTokens: summary.reasoningOutputTokens + source.reasoningOutputTokens,
        totalTokens: summary.totalTokens + source.totalTokens,
      }),
      emptyStatsSummary(),
    );
    return { total, bySource };
  }

  async getStatsTrend(
    options: SessionStatsOptions = {},
    now = Date.now(),
  ): Promise<SessionStatsTrend> {
    const period = options.period ?? "today";
    const window = resolveStatsTrendWindow(period, now);
    if (!window) return { period, granularity: null, buckets: [] };
    const originPredicate = sqliteSessionOriginPredicate(options.origin);
    const trendSessionPredicates = [
      ...(options.excludeSubagents ? ["sessions.is_subagent = 0"] : []),
      ...(originPredicate ? [originPredicate] : []),
    ];
    const sessionAnd = trendSessionPredicates
      .map((predicate) => `and ${predicate}`)
      .join(" ");

    const rows = this.database.all<{
      occurred_at: number | string;
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
          from token_events events
          join local_sessions sessions on sessions.session_key = events.session_key
          where events.occurred_at >= ?
            and events.occurred_at <= ?
            ${sessionAnd}
        )
        select occurred_at, total_tokens
        from ranked
        where row_rank = 1
      `,
      Math.trunc(window.since),
      Math.trunc(window.until),
    );

    const totals = new Map<number, number>();
    for (const row of rows) {
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
