import type { SearchOptions } from "../../../../core/types";
import { resolveDateRange, type DateRangeFilter } from "../../date-range";

export type QueryBuilderVisibility = "default" | "favorites" | "pinned" | "hidden";

export interface QueryBuilderState {
  source: SearchOptions["source"];
  tag: string | undefined;
  visibility: QueryBuilderVisibility;
  dateRange: DateRangeFilter;
}

export const DEFAULT_QUERY_BUILDER_STATE: QueryBuilderState = {
  source: undefined,
  tag: undefined,
  visibility: "default",
  dateRange: "all",
};

/**
 * Converts the builder state into a SearchOptions patch that can be spread into
 * the options passed to searchSessionPage. Date range is resolved to concrete
 * timestamps at call time.
 */
export function toSearchOptionsPatch(state: QueryBuilderState, now = Date.now()): Partial<SearchOptions> {
  const { dateFrom, dateTo } = resolveDateRange(state.dateRange, now);
  return {
    source: state.source,
    tag: state.tag,
    visibility: state.visibility,
    dateFrom,
    dateTo,
  };
}

/** True when the builder differs from the defaults in any way. */
export function hasActiveFilters(state: QueryBuilderState): boolean {
  return (
    state.source !== DEFAULT_QUERY_BUILDER_STATE.source ||
    state.tag !== DEFAULT_QUERY_BUILDER_STATE.tag ||
    state.visibility !== DEFAULT_QUERY_BUILDER_STATE.visibility ||
    state.dateRange !== DEFAULT_QUERY_BUILDER_STATE.dateRange
  );
}

/** Counts how many filters are actively set (for the badge on the filter button). */
export function countActiveFilters(state: QueryBuilderState): number {
  let count = 0;
  if (state.source !== undefined) count++;
  if (state.tag !== undefined) count++;
  if (state.visibility !== "default") count++;
  if (state.dateRange !== "all") count++;
  return count;
}
