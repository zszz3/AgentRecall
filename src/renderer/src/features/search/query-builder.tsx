import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Bookmark, RotateCcw, Search, X } from "lucide-react";
import type { SearchOptions } from "../../../../core/types";
import { DATE_RANGE_OPTIONS, dateRangeLabel } from "../../date-range";
import { localize, type LanguageMode } from "../../language";
import {
  DEFAULT_QUERY_BUILDER_STATE,
  countActiveFilters,
  hasActiveFilters,
  type QueryBuilderState,
  type QueryBuilderVisibility,
} from "./query-builder-types";

const VISIBILITY_OPTIONS: Array<{ value: QueryBuilderVisibility; en: string; zh: string }> = [
  { value: "default", en: "All", zh: "全部" },
  { value: "favorites", en: "Favorites", zh: "收藏" },
  { value: "pinned", en: "Pinned", zh: "置顶" },
  { value: "hidden", en: "Hidden", zh: "隐藏" },
];

export function QueryBuilder({
  initial,
  sourceOptions,
  tagOptions,
  language,
  onApply,
  onClose,
  onSaveSearch,
}: {
  initial: QueryBuilderState;
  sourceOptions: Array<{ label: string; value: SearchOptions["source"] }>;
  tagOptions: string[];
  language: LanguageMode;
  onApply: (state: QueryBuilderState) => void;
  onClose: () => void;
  onSaveSearch?: (name: string, state: QueryBuilderState) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [draft, setDraft] = useState<QueryBuilderState>(initial);
  const [saveName, setSaveName] = useState("");
  const [showSave, setShowSave] = useState(false);

  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const active = hasActiveFilters(draft);
  const activeCount = countActiveFilters(draft);

  function update(patch: Partial<QueryBuilderState>): void {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function handleSave(): void {
    const name = saveName.trim();
    if (!name || !onSaveSearch) return;
    onSaveSearch(name, draft);
    setSaveName("");
    setShowSave(false);
  }

  return (
    <div className="query-builder">
      <header className="query-builder-head">
        <h3>{l("Advanced search", "高级搜索")}</h3>
        {activeCount > 0 ? <span className="query-builder-count">{activeCount}</span> : null}
        <button className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
          <X size={15} />
        </button>
      </header>

      <div className="query-builder-field">
        <label>{l("Agent source", "Agent 来源")}</label>
        <select
          value={draft.source ?? ""}
          onChange={(event) => update({ source: event.currentTarget.value === "" ? undefined : (event.currentTarget.value as SearchOptions["source"]) })}
        >
          <option value="">{l("All sources", "全部来源")}</option>
          {sourceOptions.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="query-builder-field">
        <label>{l("Tag", "标签")}</label>
        <select value={draft.tag ?? ""} onChange={(event) => update({ tag: event.currentTarget.value === "" ? undefined : event.currentTarget.value })}>
          <option value="">{l("All tags", "全部标签")}</option>
          {tagOptions.map((tagName) => (
            <option key={tagName} value={tagName}>
              {tagName}
            </option>
          ))}
        </select>
      </div>

      <div className="query-builder-field">
        <label>{l("Time range", "时间范围")}</label>
        <div className="query-builder-segment" role="group">
          {DATE_RANGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={draft.dateRange === option.value ? "active" : ""}
              onClick={() => update({ dateRange: option.value })}
            >
              {dateRangeLabel(option.value, language)}
            </button>
          ))}
        </div>
      </div>

      <div className="query-builder-field">
        <label>{l("Visibility", "可见性")}</label>
        <div className="query-builder-segment" role="group">
          {VISIBILITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={draft.visibility === option.value ? "active" : ""}
              onClick={() => update({ visibility: option.value })}
            >
              {l(option.en, option.zh)}
            </button>
          ))}
        </div>
      </div>

      <footer className="query-builder-actions">
        <button className="query-builder-button" onClick={() => setDraft(DEFAULT_QUERY_BUILDER_STATE)} disabled={!active}>
          <RotateCcw size={13} /> {l("Reset", "重置")}
        </button>
        {onSaveSearch ? (
          <button className="query-builder-button" onClick={() => setShowSave((value) => !value)}>
            <Bookmark size={13} /> {l("Save", "保存")}
          </button>
        ) : null}
        <button className="query-builder-button query-builder-button-primary" onClick={() => onApply(draft)}>
          <Search size={13} /> {l("Apply", "应用")}
        </button>
      </footer>

      {showSave && onSaveSearch ? (
        <div className="query-builder-save">
          <input
            value={saveName}
            onChange={(event) => setSaveName(event.currentTarget.value)}
            placeholder={l("Search name", "搜索名称")}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSave();
            }}
          />
          <button className="query-builder-button query-builder-button-primary" onClick={handleSave} disabled={!saveName.trim()}>
            {l("Save search", "保存搜索")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
