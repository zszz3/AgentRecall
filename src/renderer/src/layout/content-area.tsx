import type { ComponentProps, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { SearchOptions, SessionMatchHit, SessionSearchResult, SessionSortBy } from "../../../core/types";
import type { SavedSearch } from "../../../core/store/saved-searches";
import { localize, type LanguageMode } from "../language";
import type { LiveSessionState } from "../live-filter";
import { QueryBuilder } from "../features/search/query-builder";
import { SavedSearchesPanel } from "../features/search/saved-searches-panel";
import { GroupedResults } from "../features/search/grouped-results";
import type { GroupMode } from "../features/search/group-logic";
import type { QueryBuilderState } from "../features/search/query-builder-types";
import { Toolbar, type ToolbarProps } from "./toolbar";

export type ContentAreaProps = {
  language: LanguageMode;
  toolbar: ToolbarProps;
  queryBuilderOpen: boolean;
  queryBuilderInitial: QueryBuilderState;
  sourceOptions: Array<{ label: string; value: SearchOptions["source"] }>;
  tagOptions: string[];
  onApplyQueryBuilder: (state: QueryBuilderState) => void;
  onCloseQueryBuilder: () => void;
  onSaveSearch: (name: string, state: QueryBuilderState) => void;
  savedSearchesOpen: boolean;
  savedSearches: SavedSearch[];
  onApplySavedSearch: (saved: SavedSearch) => void;
  onDeleteSavedSearch: (id: number) => void;
  onCloseSavedSearches: () => void;
  resultsHeader: ReactNode;
  sessions: ComponentProps<typeof GroupedResults>["sessions"];
  groupMode: GroupMode;
  sortBy: SessionSortBy;
  selectedKey: string | null;
  liveStateFor: (session: SessionSearchResult) => LiveSessionState;
  onOpenMatch: (session: SessionSearchResult, hit: SessionMatchHit) => void;
  onSelect: (sessionKey: string) => void;
  onOpen: (session: SessionSearchResult) => void;
  onRename: (session: SessionSearchResult) => void;
  onFavorite: (session: SessionSearchResult) => void;
  onContextMenu: (event: ReactMouseEvent, session: SessionSearchResult) => void;
  hasMoreSessions: boolean;
  onLoadMore: () => void;
  loadMoreCount: number;
};

export function ContentArea(props: ContentAreaProps): ReactElement {
  const {
    language,
    toolbar,
    queryBuilderOpen,
    queryBuilderInitial,
    sourceOptions,
    tagOptions,
    onApplyQueryBuilder,
    onCloseQueryBuilder,
    onSaveSearch,
    savedSearchesOpen,
    savedSearches,
    onApplySavedSearch,
    onDeleteSavedSearch,
    onCloseSavedSearches,
    resultsHeader,
    sessions,
    groupMode,
    sortBy,
    selectedKey,
    liveStateFor,
    onOpenMatch,
    onSelect,
    onOpen,
    onRename,
    onFavorite,
    onContextMenu,
    hasMoreSessions,
    onLoadMore,
    loadMoreCount,
  } = props;
  const t = (en: string, zh: string) => localize(language, en, zh);

  return (
    <section className="content">
      <Toolbar {...toolbar} />

      {queryBuilderOpen ? (
        <QueryBuilder
          initial={queryBuilderInitial}
          sourceOptions={sourceOptions}
          tagOptions={tagOptions}
          language={language}
          onApply={onApplyQueryBuilder}
          onClose={onCloseQueryBuilder}
          onSaveSearch={onSaveSearch}
        />
      ) : null}

      {savedSearchesOpen ? (
        <SavedSearchesPanel
          savedSearches={savedSearches}
          language={language}
          onApply={onApplySavedSearch}
          onDelete={onDeleteSavedSearch}
          onClose={onCloseSavedSearches}
        />
      ) : null}

      {resultsHeader}

      <div className="results">
        <GroupedResults
          sessions={sessions}
          groupMode={groupMode}
          sortBy={sortBy}
          selectedKey={selectedKey}
          liveStateFor={liveStateFor}
          language={language}
          onOpenMatch={onOpenMatch}
          onSelect={onSelect}
          onOpen={onOpen}
          onRename={onRename}
          onFavorite={onFavorite}
          onContextMenu={onContextMenu}
        />
        {sessions.length === 0 && !hasMoreSessions ? <div className="empty">{t("No sessions found.", "没有找到会话。")}</div> : null}
        {hasMoreSessions ? (
          <button className="load-more-sessions" onClick={onLoadMore}>
            <ChevronDown size={14} />
            {t(`Load ${loadMoreCount} more`, `再加载 ${loadMoreCount} 个`)}
          </button>
        ) : null}
      </div>
    </section>
  );
}
