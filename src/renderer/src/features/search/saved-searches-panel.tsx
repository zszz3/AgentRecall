import type { ReactElement } from "react";
import { Bookmark, Trash2, X } from "lucide-react";
import type { SavedSearch } from "../../../../core/store/saved-searches";
import { localize, type LanguageMode } from "../../language";

export function SavedSearchesPanel({
  savedSearches,
  language,
  onApply,
  onDelete,
  onClose,
}: {
  savedSearches: SavedSearch[];
  language: LanguageMode;
  onApply: (savedSearch: SavedSearch) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);

  return (
    <div className="saved-searches-panel">
      <header className="saved-searches-head">
        <h3>{l("Saved searches", "保存的搜索")}</h3>
        <button className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
          <X size={15} />
        </button>
      </header>

      {savedSearches.length === 0 ? (
        <p className="saved-searches-empty">
          {l("No saved searches yet. Use the advanced search panel to build and save one.", "暂无保存的搜索。使用高级搜索面板构建并保存一个。")}
        </p>
      ) : (
        <ul className="saved-searches-list">
          {savedSearches.map((saved) => (
            <li key={saved.id} className="saved-search-item">
              <button className="saved-search-apply" onClick={() => onApply(saved)} title={describeSearch(saved)}>
                <Bookmark size={13} />
                <span className="saved-search-name">{saved.name}</span>
                <span className="saved-search-meta">
                  {l(`used ${saved.useCount}×`, `已用 ${saved.useCount} 次`)}
                </span>
              </button>
              <button
                className="saved-search-delete"
                onClick={() => onDelete(saved.id)}
                aria-label={`${l("Delete", "删除")}: ${saved.name}`}
                title={l("Delete saved search", "删除保存的搜索")}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describeSearch(saved: SavedSearch): string {
  const parts: string[] = [];
  if (saved.options.query) parts.push(saved.options.query);
  if (saved.options.source) parts.push(String(saved.options.source));
  if (saved.options.tag) parts.push(`#${saved.options.tag}`);
  return parts.join(" · ") || saved.name;
}
