import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  LiveSessionSnapshot,
  ProjectSummary,
  SearchOptions,
  SessionDailyTokenUsage,
  SessionEnvironment,
  SessionSearchResult,
  SessionSortBy,
} from "../../../../core/types";
import { resolveDateRange, type DateRangeFilter } from "../../date-range";
import {
  filterSessionsByLiveStatus,
  type LiveStatusFilter,
} from "../../live-filter";
import { resolveSearchScope } from "../search/search-scope";

export type SessionVisibility = "default" | "favorites" | "pinned" | "hidden";

export const INITIAL_SESSION_LIMIT = 30;
export const SESSION_PAGE_SIZE = 30;

export function useSessionCatalog({
  active,
  liveSessions,
  projects,
  environments,
  tags,
}: {
  active: boolean;
  liveSessions: LiveSessionSnapshot;
  projects: ProjectSummary[];
  environments: SessionEnvironment[];
  tags: string[];
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SearchOptions["source"]>("all");
  const [environmentId, setEnvironmentId] = useState<string | "all">("all");
  const [tag, setTag] = useState<string | undefined>();
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [projectEnvironmentId, setProjectEnvironmentId] = useState<string | undefined>();
  const [visibility, setVisibility] = useState<SessionVisibility>("default");
  const [dateRange, setDateRange] = useState<DateRangeFilter>("all");
  const [customDateRange, setCustomDateRange] = useState<
    Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive"> | null
  >(null);
  const sortBy: SessionSortBy = "smart";
  const [liveStatus, setLiveStatus] = useState<LiveStatusFilter>("all");
  const [pagination, setPagination] = useState({
    scopeKey: "",
    limit: INITIAL_SESSION_LIMIT,
  });
  const [sessionTotalCount, setSessionTotalCount] = useState(0);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const loadSeqRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const liveSessionKeys = useMemo(
    () => new Set(liveSessions.sessions.map((session) => `${session.family}:${session.rawId}`)),
    [liveSessions],
  );
  const liveDetectionFailed = Boolean(liveSessions.error);
  const liveSearchKeys = useMemo(() => [...liveSessionKeys], [liveSessionKeys]);
  const searchScopeKey = useMemo(
    () =>
      JSON.stringify([
        query,
        source,
        environmentId,
        tag ?? "",
        projectPath ?? "",
        projectEnvironmentId ?? "",
        visibility,
        dateRange,
        customDateRange?.dayStart ?? null,
        customDateRange?.dayEndExclusive ?? null,
        sortBy,
        liveStatus,
      ]),
    [
      query,
      source,
      environmentId,
      tag,
      projectPath,
      projectEnvironmentId,
      visibility,
      dateRange,
      customDateRange,
      sortBy,
      liveStatus,
    ],
  );
  const sessionLimit = pagination.scopeKey === searchScopeKey
    ? pagination.limit
    : INITIAL_SESSION_LIMIT;

  const load = useCallback(async () => {
    const requestId = ++loadSeqRef.current;
    const searchScope = resolveSearchScope(
      environmentId,
      projectPath,
      projectEnvironmentId,
    );
    const { dateFrom, dateTo } = customDateRange
      ? {
          dateFrom: customDateRange.dayStart,
          dateTo: customDateRange.dayEndExclusive - 1,
        }
      : resolveDateRange(dateRange);
    const options: SearchOptions = {
      query,
      source,
      tag,
      projectPath: searchScope.projectPath,
      environmentId: searchScope.environmentId,
      visibility,
      sortBy,
      dateFrom,
      dateTo,
      limit: sessionLimit,
      liveStatus: liveStatus === "all" ? undefined : liveStatus,
      liveSessionKeys:
        liveStatus === "all" || liveDetectionFailed ? [] : liveSearchKeys,
    };
    const page = searchScope.projectEnvironmentConflict
      ? { sessions: [], totalCount: 0, hasMore: false }
      : await window.sessionSearch.searchSessionPage(options);
    if (requestId !== loadSeqRef.current) return;

    startTransition(() => {
      setResults(page.sessions);
      setSessionTotalCount(page.totalCount);
      setHasMoreSessions(page.hasMore);
      setSelectedKey((current) =>
        current &&
        !page.sessions.some((session) => session.sessionKey === current)
          ? null
          : current,
      );
    });
  }, [
    query,
    source,
    environmentId,
    tag,
    projectPath,
    projectEnvironmentId,
    visibility,
    dateRange,
    customDateRange,
    sortBy,
    sessionLimit,
    liveStatus,
    liveDetectionFailed,
    liveSearchKeys,
  ]);

  const clearProjectFilter = useCallback((): void => {
    setProjectPath(undefined);
    setProjectEnvironmentId(undefined);
  }, []);

  const clearProjectScopeFilter = useCallback((): void => {
    clearProjectFilter();
    setTag(undefined);
  }, [clearProjectFilter]);

  const selectEnvironment = useCallback(
    (nextEnvironmentId: string | "all"): void => {
      setEnvironmentId(nextEnvironmentId);
    },
    [],
  );

  const clearEnvironmentScopeFilter = useCallback((): void => {
    selectEnvironment("all");
    clearProjectFilter();
    setTag(undefined);
  }, [clearProjectFilter, selectEnvironment]);

  const selectProject = useCallback((project: ProjectSummary): void => {
    setProjectPath(project.path);
    setProjectEnvironmentId(project.environmentId);
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => {
    if (
      environmentId !== "all" &&
      environments.length > 0 &&
      !environments.some((environment) => environment.id === environmentId)
    ) {
      setEnvironmentId("all");
    }
    if (
      projectEnvironmentId &&
      environments.length > 0 &&
      !environments.some(
        (environment) => environment.id === projectEnvironmentId,
      )
    ) {
      clearProjectFilter();
    }
  }, [
    clearProjectFilter,
    environmentId,
    environments,
    projectEnvironmentId,
  ]);

  useEffect(() => {
    if (tag && tags.length > 0 && !tags.includes(tag)) setTag(undefined);
  }, [tag, tags]);

  useEffect(() => {
    if (
      projectPath &&
      projects.length > 0 &&
      !projects.some((project) =>
        projectEnvironmentId
          ? project.path === projectPath &&
            project.environmentId === projectEnvironmentId
          : project.path === projectPath,
      )
    ) {
      clearProjectFilter();
    }
  }, [
    clearProjectFilter,
    projectPath,
    projectEnvironmentId,
    projects,
  ]);

  const displayedResults = useMemo(
    () =>
      filterSessionsByLiveStatus(
        results,
        liveSessionKeys,
        liveStatus,
        liveDetectionFailed,
      ),
    [results, liveSessionKeys, liveStatus, liveDetectionFailed],
  );
  const selected = useMemo(
    () =>
      displayedResults.find(
        (session) => session.sessionKey === selectedKey,
      ) ?? null,
    [displayedResults, selectedKey],
  );

  useEffect(() => {
    setSelectedKey((current) =>
      current &&
      !displayedResults.some((session) => session.sessionKey === current)
        ? null
        : current,
    );
  }, [displayedResults]);

  const loadMore = useCallback((): void => {
    setPagination((current) => ({
      scopeKey: searchScopeKey,
      limit: (current.scopeKey === searchScopeKey
        ? current.limit
        : INITIAL_SESSION_LIMIT) + SESSION_PAGE_SIZE,
    }));
  }, [searchScopeKey]);

  return {
    query,
    setQuery,
    source,
    setSource,
    environmentId,
    setEnvironmentId,
    tag,
    setTag,
    projectPath,
    projectEnvironmentId,
    visibility,
    setVisibility,
    dateRange,
    setDateRange,
    customDateRange,
    setCustomDateRange,
    liveStatus,
    setLiveStatus,
    sessionTotalCount,
    hasMoreSessions,
    displayedResults,
    selectedKey,
    setSelectedKey,
    selected,
    searchRef,
    liveSessionKeys,
    liveDetectionFailed,
    liveSearchKeys,
    load,
    loadMore,
    clearProjectFilter,
    clearProjectScopeFilter,
    clearEnvironmentScopeFilter,
    selectEnvironment,
    selectProject,
  };
}
