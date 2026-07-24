import type { ReactElement, RefObject } from "react";
import {
  ArrowRightLeft,
  Bookmark,
  CalendarDays,
  Cloud,
  Database,
  KeyRound,
  Layers,
  PackageSearch,
  Settings,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type { SessionSortBy } from "../../../core/types";
import { localize, type LanguageMode } from "../language";
import { DATE_RANGE_OPTIONS, dateRangeLabel, dateRangeShortLabel, type DateRangeFilter } from "../date-range";
import { type LiveStatusFilter } from "../live-filter";
import { liveStatusFilterLabel } from "../session-ui";
import { SearchBox } from "../features/search/search-box";
import type { GroupMode } from "../features/search/group-logic";

export const LIVE_STATUS_FILTERS: Array<{ label: string; value: LiveStatusFilter }> = [
  { label: "All", value: "all" },
  { label: "Open", value: "open" },
  { label: "Closed", value: "closed" },
];

export type ToolbarProps = {
  language: LanguageMode;
  platform: NodeJS.Platform;
  searchRef: RefObject<HTMLInputElement | null>;
  searchPlaceholder: string;
  onSearch: (query: string) => void;
  activeFilterCount: number;
  queryBuilderOpen: boolean;
  onToggleQueryBuilder: () => void;
  savedSearchesOpen: boolean;
  onToggleSavedSearches: () => void;
  groupMode: GroupMode;
  onCycleGroupMode: () => void;
  liveStatus: LiveStatusFilter;
  onSelectLiveStatus: (status: LiveStatusFilter) => void;
  dateRange: DateRangeFilter;
  onSelectDateRange: (range: DateRangeFilter) => void;
  sortBy: SessionSortBy;
  onSelectSortBy: (sort: SessionSortBy) => void;
  aiAssistantOpen: boolean;
  onOpenAiAssistant: () => void;
  skillsOpen: boolean;
  onOpenSkills: () => void;
  assetsOpen: boolean;
  onOpenAssets: () => void;
  remoteSessionsOpen: boolean;
  onOpenRemoteSessions: () => void;
  apiConfigOpen: boolean;
  onOpenApiConfig: () => void;
  shouldSignalAppUpdate: boolean;
  onOpenSettings: () => void;
};

export function Toolbar(props: ToolbarProps): ReactElement {
  const {
    language,
    platform,
    searchRef,
    searchPlaceholder,
    onSearch,
    activeFilterCount,
    queryBuilderOpen,
    onToggleQueryBuilder,
    savedSearchesOpen,
    onToggleSavedSearches,
    groupMode,
    onCycleGroupMode,
    liveStatus,
    onSelectLiveStatus,
    dateRange,
    onSelectDateRange,
    sortBy,
    onSelectSortBy,
    aiAssistantOpen,
    onOpenAiAssistant,
    skillsOpen,
    onOpenSkills,
    assetsOpen,
    onOpenAssets,
    remoteSessionsOpen,
    onOpenRemoteSessions,
    apiConfigOpen,
    onOpenApiConfig,
    shouldSignalAppUpdate,
    onOpenSettings,
  } = props;
  const t = (en: string, zh: string) => localize(language, en, zh);

  return (
    <header className="toolbar">
      <div className="toolbar-primary">
        <SearchBox
          platform={platform}
          ref={searchRef}
          placeholder={searchPlaceholder}
          recentLabel={t("Recent searches", "最近搜索")}
          clearRecentLabel={t("Clear", "清空")}
          deleteRecentLabel={t("Delete recent search", "删除最近搜索")}
          onSearch={onSearch}
        />
        <div className="toolbar-discovery" role="group" aria-label={t("Search tools", "搜索工具")}>
          <button
            className={`icon-button toolbar-icon-button ${queryBuilderOpen ? "active" : ""}`}
            onClick={onToggleQueryBuilder}
            title={t("Advanced search", "高级搜索")}
            aria-label={t("Advanced search", "高级搜索")}
          >
            <SlidersHorizontal size={15} />
            {activeFilterCount > 0 ? <span className="toolbar-badge">{activeFilterCount}</span> : null}
          </button>
          <button
            className={`icon-button toolbar-icon-button ${savedSearchesOpen ? "active" : ""}`}
            onClick={onToggleSavedSearches}
            title={t("Saved searches", "保存的搜索")}
            aria-label={t("Saved searches", "保存的搜索")}
          >
            <Bookmark size={15} />
          </button>
          <button
            className={`icon-button toolbar-icon-button ${groupMode !== "flat" ? "active" : ""}`}
            onClick={onCycleGroupMode}
            title={t("Group results", "分组展示")}
            aria-label={t("Group results", "分组展示")}
          >
            <Layers size={15} />
          </button>
        </div>
      </div>
      <div className="toolbar-secondary">
        <div className="toolbar-filters">
          <div className="live-filter" role="group" aria-label="Live session status">
            {LIVE_STATUS_FILTERS.map((option) => (
              <button
                key={option.value}
                className={liveStatus === option.value ? "active" : ""}
                onClick={() => onSelectLiveStatus(option.value)}
              >
                {liveStatusFilterLabel(option.value, language)}
              </button>
            ))}
          </div>
          <div className="date-filter" role="group" aria-label={t("Session time range", "会话时间范围")}>
            <CalendarDays size={14} aria-hidden="true" />
            {DATE_RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={dateRange === option.value ? "active" : ""}
                onClick={() => onSelectDateRange(option.value)}
                title={dateRangeLabel(option.value, language)}
                aria-label={dateRangeLabel(option.value, language)}
              >
                {dateRangeShortLabel(option.value, language)}
              </button>
            ))}
          </div>
          <div className="sort-filter" role="group" aria-label={t("Sort order", "排序方式")}>
            <ArrowRightLeft size={14} aria-hidden="true" />
            <button
              className={sortBy === "smart" ? "active" : ""}
              onClick={() => onSelectSortBy("smart")}
              title={t("Smart: relevance + recency", "智能：相关性 + 时间")}
            >
              {t("Smart", "智能")}
            </button>
            <button
              className={sortBy === "activity" ? "active" : ""}
              onClick={() => onSelectSortBy("activity")}
              title={t("Most recent first", "最近活跃优先")}
            >
              {t("Recent", "最新")}
            </button>
            <button
              className={sortBy === "created" ? "active" : ""}
              onClick={() => onSelectSortBy("created")}
              title={t("Oldest first", "最早创建优先")}
            >
              {t("Oldest", "最早")}
            </button>
          </div>
        </div>
        <div className="top-actions">
          <button
            className={`icon-button toolbar-icon-button ${aiAssistantOpen ? "active" : ""}`}
            onClick={onOpenAiAssistant}
            title={t("AI session finder", "AI 找会话")}
            aria-label={t("AI session finder", "AI 找会话")}
          >
            <Sparkles size={15} />
          </button>
          <button
            className={`icon-button toolbar-icon-button ${skillsOpen ? "active" : ""}`}
            onClick={onOpenSkills}
            title={t("Skills", "Skills 管理")}
            aria-label={t("Skills", "Skills 管理")}
          >
            <PackageSearch size={15} />
          </button>
          <button
            className={`icon-button toolbar-icon-button ${assetsOpen ? "active" : ""}`}
            onClick={onOpenAssets}
            title={t("Digital Assets", "数字资产")}
            aria-label={t("Digital Assets", "数字资产")}
          >
            <Database size={15} />
          </button>
          <button
            className={`icon-button toolbar-icon-button ${remoteSessionsOpen ? "active" : ""}`}
            onClick={onOpenRemoteSessions}
            title={t("Remote sessions", "远程会话")}
            aria-label={t("Remote sessions", "远程会话")}
          >
            <Cloud size={15} />
          </button>
          <button
            className={`icon-button toolbar-icon-button ${apiConfigOpen ? "active" : ""}`}
            onClick={onOpenApiConfig}
            title={t("API configuration", "API 配置")}
            aria-label={t("API configuration", "API 配置")}
          >
            <KeyRound size={15} />
          </button>
          <button
            className={`icon-button toolbar-icon-button ${shouldSignalAppUpdate ? "update-available" : ""}`}
            onClick={onOpenSettings}
            title={shouldSignalAppUpdate ? t("Update available", "有新版本可用") : t("Settings", "设置")}
            aria-label={shouldSignalAppUpdate ? t("Update available", "有新版本可用") : t("Settings", "设置")}
          >
            <Settings size={15} />
            {shouldSignalAppUpdate ? <span className="update-indicator" aria-hidden="true" /> : null}
          </button>
        </div>
      </div>
    </header>
  );
}
