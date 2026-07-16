import { forwardRef, useState } from "react";
import { History, Search, X } from "lucide-react";
import {
  clearSearchHistory,
  deleteSearch,
  readSearchHistory,
  recordSearch,
} from "../../search-history";

// The search input keeps its typed value in local state so each keystroke only
// re-renders this tiny component instead of the whole App tree (sidebar, stats,
// and the full result list). The query is pushed to the parent only when the
// user presses Enter, so typing never triggers background search work.
export const SearchBox = forwardRef<
  HTMLInputElement,
  {
    platform: NodeJS.Platform;
    placeholder: string;
    recentLabel: string;
    clearRecentLabel: string;
    deleteRecentLabel: string;
    onSearch: (value: string) => void;
  }
>(function SearchBox({ platform, placeholder, recentLabel, clearRecentLabel, deleteRecentLabel, onSearch }, ref) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : readSearchHistory(window.localStorage),
  );
  const [focused, setFocused] = useState(false);

  function handleChange(next: string): void {
    if (value.length > 0 && next.length === 0) onSearch("");
    setValue(next);
    setFocused(next.length > 0);
  }

  function selectRecentSearch(query: string): void {
    setValue(query);
    onSearch(query);
    setHistory((current) => recordSearch(window.localStorage, current, query));
    setFocused(false);
  }

  function runSearch(): void {
    onSearch(value);
    setHistory((current) => recordSearch(window.localStorage, current, value));
    setFocused(false);
  }

  const showHistory = focused && value.length === 0 && history.length > 0;

  return (
    <div className="searchbox">
      <Search size={18} />
      <input
        ref={ref}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onFocus={() => {
          setHistory(readSearchHistory(window.localStorage));
          setFocused(true);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setFocused(false);
            event.currentTarget.blur();
          } else if (!event.metaKey && !event.ctrlKey && event.key === "Enter") {
            runSearch();
          }
        }}
        placeholder={placeholder}
      />
      <span className="kbd-hint" title={placeholder}>Enter</span>
      <span className="kbd-hint" title="Resume selected session in the default terminal">
        {platform === "darwin" ? "⌘↵" : "Ctrl+Enter"}
      </span>
      {showHistory ? (
        <div className="recent-search-dropdown" onMouseDown={(event) => event.preventDefault()}>
          <div className="recent-search-header">
            <span>{recentLabel}</span>
            <button
              type="button"
              onClick={() => setHistory(clearSearchHistory(window.localStorage))}
            >
              {clearRecentLabel}
            </button>
          </div>
          <div className="recent-search-list">
            {history.map((query) => (
              <div className="recent-search-item" key={query}>
                <button type="button" className="recent-search-select" onClick={() => selectRecentSearch(query)} title={query}>
                  <History size={14} />
                  <span>{query}</span>
                </button>
                <button
                  type="button"
                  className="recent-search-delete"
                  aria-label={`${deleteRecentLabel}: ${query}`}
                  title={deleteRecentLabel}
                  onClick={(event) => {
                    event.stopPropagation();
                    setHistory((current) => deleteSearch(window.localStorage, current, query));
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
});


