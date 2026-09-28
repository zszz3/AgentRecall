import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LIVE_SESSION_REFRESH_INTERVAL_MS, QUOTA_REFRESH_INTERVAL_MS } from "../../../../core/refresh-policy";
import type {
  LiveSessionSnapshot,
  SessionSearchResult,
  SessionOriginFilter,
  SessionStats,
  SessionStatsPeriod,
  UsageQuotaSnapshot,
} from "../../../../core/types";
import type { QuotaFeedback, StatsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import { LiveSessionSnapshotRefreshCoordinator } from "../../live-filter";
import { WORKBENCH_SESSION_LIMIT } from "../../session-ui";

const EMPTY_STATS: SessionStats = {
  total: {
    sessionCount: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
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

export function useWorkbenchOverview(language: LanguageMode, active: boolean) {
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SessionSearchResult[]>([]);
  const [stats, setStats] = useState<SessionStats>(EMPTY_STATS);
  const [statsPeriod, setStatsPeriod] = useState<SessionStatsPeriod>("today");
  const [statsOrigin, setStatsOrigin] = useState<SessionOriginFilter>("ordinary");
  const [statsRefreshing, setStatsRefreshing] = useState(false);
  const [statsFeedback, setStatsFeedback] = useState<StatsFeedback>(null);
  const [quotas, setQuotas] = useState<UsageQuotaSnapshot>(EMPTY_QUOTAS);
  const [quotaLoading, setQuotaLoading] = useState(true);
  const [quotaFeedback, setQuotaFeedback] = useState<QuotaFeedback>(null);
  const [liveSessions, setLiveSessions] = useState<LiveSessionSnapshot>(EMPTY_LIVE_SESSIONS);
  const liveSessionRefreshCoordinator = useRef(new LiveSessionSnapshotRefreshCoordinator()).current;
  const sessionsLoadSequence = useRef(0);
  const statsLoadSequence = useRef(0);
  const quotaLoadSequence = useRef(0);
  const alive = useRef(true);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const enabled = active && visible;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const statsPending = useRef<{ key: string; request: Promise<SessionStats> } | null>(null);
  const quotaPending = useRef<Promise<UsageQuotaSnapshot> | null>(null);
  const feedbackTimers = useRef(new Set<number>());

  useEffect(() => {
    alive.current = true;
    const visibilityChanged = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", visibilityChanged);
      for (const timer of feedbackTimers.current) window.clearTimeout(timer);
      feedbackTimers.current.clear();
    };
  }, []);
  useEffect(() => {
    sessionsLoadSequence.current++; statsLoadSequence.current++; quotaLoadSequence.current++;
    statsPending.current = null; quotaPending.current = null;
    if (!enabled) {
      for (const timer of feedbackTimers.current) window.clearTimeout(timer);
      feedbackTimers.current.clear();
      setStatsFeedback(null); setQuotaFeedback(null); setStatsRefreshing(false); setQuotaLoading(false);
    }
  }, [enabled]);

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
    if (!enabledRef.current || !alive.current) return;
    const requestId = ++sessionsLoadSequence.current;
    if (query.trim()) {
      const page = await window.sessionSearch.searchSessionPage({
        query,
        source: "all",
        visibility: "default",
        sortBy: "smart",
        origin: statsOrigin,
        limit: WORKBENCH_SESSION_LIMIT,
      });
      if (alive.current && enabledRef.current && requestId === sessionsLoadSequence.current) setSessions(page.sessions);
      return;
    }

    const recentRequest = window.sessionSearch.searchSessionPage({
      query: "",
      source: "all",
      visibility: "default",
      sortBy: "activity",
      origin: statsOrigin,
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
          origin: statsOrigin,
          liveStatus: "open",
          liveSessionKeys: liveSearchKeys,
          limit: WORKBENCH_SESSION_LIMIT,
        })
      : Promise.resolve({ sessions: [], totalCount: 0, hasMore: false });
    const [recentPage, activePage] = await Promise.all([recentRequest, activeRequest]);
    if (!alive.current || !enabledRef.current || requestId !== sessionsLoadSequence.current) return;

    const sessionsByKey = new Map<string, SessionSearchResult>();
    for (const session of [...activePage.sessions, ...recentPage.sessions]) {
      sessionsByKey.set(session.sessionKey, session);
    }
    setSessions([...sessionsByKey.values()]);
  }, [liveDetectionFailed, liveSearchKeys, query, statsOrigin]);

  const loadStats = useCallback(async (fresh = false): Promise<void> => {
    if (!enabledRef.current || !alive.current) return;
    const requestId = ++statsLoadSequence.current;
    const key = `${statsPeriod}:${statsOrigin}`;
    // A completed index/mutation must not reuse a query started before it.
    if (fresh || statsPending.current?.key !== key) {
      const request = Promise.resolve().then(() => window.sessionSearch.getStats({
        period: statsPeriod, origin: statsOrigin, dailyHistoryDays: 90,
      })).finally(() => {
        if (statsPending.current?.request === request) statsPending.current = null;
      });
      statsPending.current = { key, request };
    }
    const nextStats = await statsPending.current.request;
    if (alive.current && enabledRef.current && requestId === statsLoadSequence.current) setStats(nextStats);
  }, [statsOrigin, statsPeriod]);

  const refreshStats = useCallback(async (): Promise<void> => {
    if (!enabledRef.current || !alive.current) return;
    setStatsRefreshing(true);
    setStatsFeedback({ kind: "running", message: t("Refreshing usage...", "正在刷新用量...") });
    try {
      await loadStats(true);
      if (!alive.current || !enabledRef.current) return;
      const message = t("Usage refreshed.", "用量已刷新。");
      setStatsFeedback({ kind: "success", message });
      const timer = window.setTimeout(() => {
        feedbackTimers.current.delete(timer);
        setStatsFeedback((current) =>
          current?.kind === "success" && current.message === message ? null : current);
      }, 1600);
      feedbackTimers.current.add(timer);
    } catch (error) {
      if (alive.current && enabledRef.current) setStatsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (alive.current) setStatsRefreshing(false);
    }
  }, [loadStats, t]);

  const loadQuotas = useCallback(async (
    mode: "initial" | "manual" | "background" = "initial",
  ): Promise<void> => {
    if (!enabledRef.current || !alive.current) return;
    const requestId = ++quotaLoadSequence.current;
    const background = mode === "background";
    if (!background) setQuotaLoading(true);
    if (mode === "manual") {
      setQuotaFeedback({
        kind: "running",
        message: t("Refreshing usage limits...", "正在刷新额度..."),
      });
    }
    try {
      if (!quotaPending.current) {
        const request = Promise.resolve().then(() => window.sessionSearch.getQuotas()).finally(() => {
          if (quotaPending.current === request) quotaPending.current = null;
        });
        quotaPending.current = request;
      }
      const nextQuotas = await quotaPending.current;
      if (!alive.current || !enabledRef.current || requestId !== quotaLoadSequence.current) return;
      setQuotas(nextQuotas);
      if (mode === "manual") {
        const message = t("Usage limits refreshed.", "额度已刷新。");
        setQuotaFeedback({ kind: "success", message });
        const timer = window.setTimeout(() => {
          feedbackTimers.current.delete(timer);
          setQuotaFeedback((current) =>
            current?.kind === "success" && current.message === message ? null : current);
        }, 1800);
        feedbackTimers.current.add(timer);
      }
    } catch (error) {
      if (!background && alive.current && enabledRef.current) {
        setQuotaFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (!background && alive.current && enabledRef.current && requestId === quotaLoadSequence.current) setQuotaLoading(false);
    }
  }, [t]);

  const refreshLiveSessions = useCallback(
    () => liveSessionRefreshCoordinator.refresh(
      () => window.sessionSearch.getLiveSessions(),
      (snapshot) => { if (alive.current) setLiveSessions(snapshot); },
    ),
    [liveSessionRefreshCoordinator],
  );

  useEffect(() => {
    if (!enabled) return;
    const initialTimer = window.setTimeout(() => void loadQuotas(), 100);
    const timer = window.setInterval(() => void loadQuotas("background"), QUOTA_REFRESH_INTERVAL_MS);
    const unsubscribe = window.sessionSearch.onQuotaUpdated((snapshot) => {
      if (alive.current && enabledRef.current) { quotaLoadSequence.current++; setQuotas(snapshot); setQuotaLoading(false); }
    });
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [enabled, loadQuotas]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refreshLiveSessions(), 300);
    const timer = window.setInterval(
      () => void refreshLiveSessions(),
      LIVE_SESSION_REFRESH_INTERVAL_MS,
    );
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [refreshLiveSessions]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      void loadStats().catch((error) => {
        if (alive.current && enabledRef.current) setStatsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [enabled, loadStats]);

  useEffect(() => {
    if (!enabled) return;
    void loadSessions().catch((error) => {
      console.warn("Failed to load workbench sessions:", error);
    });
  }, [enabled, loadSessions]);

  return {
    query,
    setQuery,
    sessions,
    stats,
    statsPeriod,
    setStatsPeriod,
    statsOrigin,
    setStatsOrigin,
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
