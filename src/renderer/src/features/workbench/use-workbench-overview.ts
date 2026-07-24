import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LIVE_SESSION_REFRESH_INTERVAL_MS, QUOTA_REFRESH_INTERVAL_MS } from "../../../../core/refresh-policy";
import type {
  LiveSessionSnapshot,
  SessionSearchResult,
  SessionStats,
  SessionStatsPeriod,
  UsageQuotaSnapshot,
} from "../../../../core/types";
import type { QuotaFeedback, StatsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import { WORKBENCH_SESSION_LIMIT } from "../../session-ui";

const EMPTY_STATS: SessionStats = {
  total: {
    sessionCount: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  },
  bySource: [],
  dailyTokenUsage: [],
  previousTotal: null,
  range: {
    period: "today",
    since: null,
    until: 0,
  },
};

const EMPTY_QUOTAS: UsageQuotaSnapshot = {
  generatedAt: "",
  providers: [],
};

const EMPTY_LIVE_SESSIONS: LiveSessionSnapshot = {
  generatedAt: "",
  sessions: [],
};

export function useWorkbenchOverview(language: LanguageMode) {
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SessionSearchResult[]>([]);
  const [stats, setStats] = useState<SessionStats>(EMPTY_STATS);
  const [statsPeriod, setStatsPeriod] = useState<SessionStatsPeriod>("today");
  const [statsRefreshing, setStatsRefreshing] = useState(false);
  const [statsFeedback, setStatsFeedback] = useState<StatsFeedback>(null);
  const [quotas, setQuotas] = useState<UsageQuotaSnapshot>(EMPTY_QUOTAS);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaFeedback, setQuotaFeedback] = useState<QuotaFeedback>(null);
  const [liveSessions, setLiveSessions] = useState<LiveSessionSnapshot>(EMPTY_LIVE_SESSIONS);
  const sessionsLoadSequence = useRef(0);
  const statsLoadSequence = useRef(0);
  const t = useCallback(
    (en: string, zh: string) => localize(language, en, zh),
    [language],
  );

  const liveSessionKeys = useMemo(
    () => new Set(liveSessions.sessions.map((session) => `${session.family}:${session.rawId}`)),
    [liveSessions],
  );
  const liveDetectionFailed = Boolean(liveSessions.error);
  const liveSearchKeys = useMemo(() => [...liveSessionKeys], [liveSessionKeys]);

  const loadSessions = useCallback(async (): Promise<void> => {
    const requestId = ++sessionsLoadSequence.current;
    if (query.trim()) {
      const page = await window.sessionSearch.searchSessionPage({
        query,
        source: "all",
        visibility: "default",
        sortBy: "smart",
        prioritizePinned: false,
        limit: WORKBENCH_SESSION_LIMIT,
      });
      if (requestId === sessionsLoadSequence.current) setSessions(page.sessions);
      return;
    }

    const recentRequest = window.sessionSearch.searchSessionPage({
      query: "",
      source: "all",
      visibility: "default",
      sortBy: "activity",
      prioritizePinned: false,
      liveStatus: liveDetectionFailed ? undefined : "closed",
      liveSessionKeys: liveDetectionFailed ? [] : liveSearchKeys,
      limit: WORKBENCH_SESSION_LIMIT,
    });
    const activeRequest = !liveDetectionFailed && liveSearchKeys.length > 0
      ? window.sessionSearch.searchSessionPage({
          query: "",
          source: "all",
          visibility: "default",
          sortBy: "activity",
          prioritizePinned: false,
          liveStatus: "open",
          liveSessionKeys: liveSearchKeys,
          limit: WORKBENCH_SESSION_LIMIT,
        })
      : Promise.resolve({ sessions: [], totalCount: 0, hasMore: false });
    const [recentPage, activePage] = await Promise.all([recentRequest, activeRequest]);
    if (requestId !== sessionsLoadSequence.current) return;

    const sessionsByKey = new Map<string, SessionSearchResult>();
    for (const session of [...activePage.sessions, ...recentPage.sessions]) {
      sessionsByKey.set(session.sessionKey, session);
    }
    setSessions([...sessionsByKey.values()]);
  }, [liveDetectionFailed, liveSearchKeys, query]);

  const loadStats = useCallback(async (): Promise<void> => {
    const requestId = ++statsLoadSequence.current;
    const nextStats = await window.sessionSearch.getStats({ period: statsPeriod });
    if (requestId === statsLoadSequence.current) setStats(nextStats);
  }, [statsPeriod]);

  const refreshStats = useCallback(async (): Promise<void> => {
    setStatsRefreshing(true);
    setStatsFeedback({ kind: "running", message: t("Refreshing usage...", "正在刷新用量...") });
    try {
      await loadStats();
      const message = t("Usage refreshed.", "用量已刷新。");
      setStatsFeedback({ kind: "success", message });
      window.setTimeout(() => {
        setStatsFeedback((current) =>
          current?.kind === "success" && current.message === message ? null : current);
      }, 1600);
    } catch (error) {
      setStatsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setStatsRefreshing(false);
    }
  }, [loadStats, t]);

  const loadQuotas = useCallback(async (
    mode: "initial" | "manual" | "background" = "initial",
  ): Promise<void> => {
    const background = mode === "background";
    if (!background) setQuotaLoading(true);
    if (mode === "manual") {
      setQuotaFeedback({
        kind: "running",
        message: t("Refreshing usage limits...", "正在刷新额度..."),
      });
    }
    try {
      const nextQuotas = await window.sessionSearch.getQuotas();
      setQuotas(nextQuotas);
      if (mode === "manual") {
        const message = t("Usage limits refreshed.", "额度已刷新。");
        setQuotaFeedback({ kind: "success", message });
        window.setTimeout(() => {
          setQuotaFeedback((current) =>
            current?.kind === "success" && current.message === message ? null : current);
        }, 1800);
      }
    } catch (error) {
      if (!background) {
        setQuotaFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (!background) setQuotaLoading(false);
    }
  }, [t]);

  const refreshLiveSessions = useCallback(async (): Promise<void> => {
    try {
      setLiveSessions(await window.sessionSearch.getLiveSessions());
    } catch (error) {
      setLiveSessions({
        generatedAt: new Date().toISOString(),
        sessions: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void loadStats().catch((error) => {
      setStatsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    });
  }, [loadStats]);

  useEffect(() => {
    void loadQuotas();
    const timer = window.setInterval(() => void loadQuotas("background"), QUOTA_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadQuotas]);

  useEffect(() => {
    void refreshLiveSessions();
    const timer = window.setInterval(
      () => void refreshLiveSessions(),
      LIVE_SESSION_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [refreshLiveSessions]);

  useEffect(() => {
    void loadSessions().catch((error) => {
      console.warn("Failed to load workbench sessions:", error);
    });
  }, [loadSessions]);

  return {
    query,
    setQuery,
    sessions,
    stats,
    statsPeriod,
    setStatsPeriod,
    statsRefreshing,
    statsFeedback,
    quotas,
    quotaLoading,
    quotaFeedback,
    liveSessions,
    liveSessionKeys,
    liveDetectionFailed,
    liveSearchKeys,
    loadSessions,
    loadStats,
    refreshStats,
    loadQuotas,
    refreshLiveSessions,
  };
}
