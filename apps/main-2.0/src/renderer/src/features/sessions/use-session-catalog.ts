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

export type SessionVisibility = "default" | "favorites" | "hidden";

const SESSION_PAGE_SIZE = 30;

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
  const [origin, setOrigin] = useState<NonNullable<SearchOptions["origin"]>>("all");
  const [environmentId, setEnvironmentId] = useState<string | "all">("all");
  const [tag, setTag] = useState<string | undefined>();
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [projectEnvironmentId, setProjectEnvironmentId] = useState<string | undefined>();
  const [visibility, setVisibility] = useState<SessionVisibility>("default");
  const [dateRange, setDateRange] = useState<DateRangeFilter>("all");
  const [customDateRange, setCustomDateRange] = useState<
    Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive"> | null
  >(null);
  const [sortBy, setSortBy] = useState<SessionSortBy>("smart");
  const [liveStatus, setLiveStatus] = useState<LiveStatusFilter>("all");
  const [pagination, setPagination] = useState({
    scopeKey: "",
    page: 1,
  });
  const [sessionTotalCount, setSessionTotalCount] = useState(0);
  const [originCounts, setOriginCounts] = useState({ ordinary: 0, agentRecall: 0, all: 0 });
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [resultsScopeKey, setResultsScopeKey] = useState<string | null>(null);
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
        origin,
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
      origin,
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
  const sessionPage = pagination.scopeKey === searchScopeKey
    ? pagination.page
    : 1;
  const sessionOffset = (sessionPage - 1) * SESSION_PAGE_SIZE;

  const load = useCallback(async () => {
    const requestId = ++loadSeqRef.current;
    const requestScopeKey = searchScopeKey;
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
      origin,
      tag,
      projectPath: searchScope.projectPath,
      environmentId: searchScope.environmentId,
      visibility,
      sortBy,
      dateFrom,
      dateTo,
      limit: SESSION_PAGE_SIZE,
      offset: sessionOffset,
      liveStatus: liveStatus === "all" ? undefined : liveStatus,
      liveSessionKeys: liveDetectionFailed ? [] : liveSearchKeys,
    };
    const page = searchScope.projectEnvironmentConflict
      ? { sessions: [], totalCount: 0, hasMore: false, originCounts: { ordinary: 0, agentRecall: 0, all: 0 } }
      : await window.sessionSearch.searchSessionPage(options);
    if (requestId !== loadSeqRef.current) return;
    const lastPage = Math.max(1, Math.ceil(page.totalCount / SESSION_PAGE_SIZE));
    if (sessionPage > lastPage) {
      setPagination({ scopeKey: requestScopeKey, page: lastPage });
      return;
    }

    startTransition(() => {
      setResults(page.sessions);
      setResultsScopeKey(requestScopeKey);
      setSessionTotalCount(page.totalCount);
      setOriginCounts(page.originCounts ?? { ordinary: page.totalCount, agentRecall: 0, all: page.totalCount });
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
    origin,
    environmentId,
    tag,
    projectPath,
    projectEnvironmentId,
    visibility,
    dateRange,
    customDateRange,
    sortBy,
    sessionOffset,
    liveStatus,
    liveDetectionFailed,
    liveSearchKeys,
    searchScopeKey,
  ]);

  const searchAllMatching = useCallback(async (ignoreDate: boolean): Promise<SessionSearchResult[]> => {
    const searchScope = resolveSearchScope(environmentId, projectPath, projectEnvironmentId);
    if (searchScope.projectEnvironmentConflict) return [];
    const { dateFrom, dateTo } = ignoreDate
      ? { dateFrom: undefined, dateTo: undefined }
      : customDateRange
        ? { dateFrom: customDateRange.dayStart, dateTo: customDateRange.dayEndExclusive - 1 }
        : resolveDateRange(dateRange);
    const page = await window.sessionSearch.searchSessionPage({
      query,
      source,
      origin,
      tag,
      projectPath: searchScope.projectPath,
      environmentId: searchScope.environmentId,
      visibility,
      sortBy,
      dateFrom,
      dateTo,
      limit: 100_000,
      liveStatus: liveStatus === "all" ? undefined : liveStatus,
      liveSessionKeys: liveDetectionFailed ? [] : liveSearchKeys,
    });
    if (page.hasMore) throw new Error("More than 100,000 sessions match. Narrow the filters first.");
    return page.sessions;
  }, [environmentId, projectPath, projectEnvironmentId, customDateRange, dateRange, query, source, origin, tag, visibility, sortBy, liveStatus, liveDetectionFailed, liveSearchKeys]);

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
    setPagination((current) => current.scopeKey === searchScopeKey
      ? current
      : { scopeKey: searchScopeKey, page: 1 });
  }, [searchScopeKey]);

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

  const resultsMatchSearchScope = resultsScopeKey === searchScopeKey;
  const displayedResults = useMemo(
    () =>
      filterSessionsByLiveStatus(
        resultsMatchSearchScope ? results : [],
        liveSessionKeys,
        liveStatus,
        liveDetectionFailed,
      ),
    [resultsMatchSearchScope, results, liveSessionKeys, liveStatus, liveDetectionFailed],
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

  const goToPage = useCallback((page: number): void => {
    setPagination({
      scopeKey: searchScopeKey,
      page: Math.max(1, Math.floor(page)),
    });
  }, [searchScopeKey]);

  return {
    query,
    setQuery,
    source,
    setSource,
    origin,
    setOrigin,
    originCounts,
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
    sortBy,
    setSortBy,
    liveStatus,
    setLiveStatus,
    sessionTotalCount: resultsMatchSearchScope ? sessionTotalCount : 0,
    displayedResults,
    selectedKey,
    setSelectedKey,
    selected,
    searchRef,
    liveSessionKeys,
    liveDetectionFailed,
    liveSearchKeys,
    load,
    currentPage: sessionPage,
    totalPages: Math.max(1, Math.ceil((resultsMatchSearchScope ? sessionTotalCount : 0) / SESSION_PAGE_SIZE)),
    goToPage,
    searchAllMatching,
    clearProjectFilter,
    clearProjectScopeFilter,
    clearEnvironmentScopeFilter,
    selectEnvironment,
    selectProject,
  };
}
