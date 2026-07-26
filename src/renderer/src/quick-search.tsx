import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Search } from "lucide-react";
import type { SearchOptions, SessionSearchResult } from "../../core/types";
import { formatRelativeTime } from "../../core/format-session";

export function quickSearchOptions(query: string): SearchOptions {
  return { query, limit: 8, sortBy: "smart" };
}

export function QuickSearch(): ReactElement {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmedQuery = useMemo(() => query.trim(), [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.sessionSearch.searchSessions(quickSearchOptions(trimmedQuery))
        .then((sessions) => {
          if (cancelled) return;
          setResults(sessions);
          setSelectedIndex(0);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, trimmedQuery ? 100 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmedQuery]);

  const openSelected = (): void => {
    const selected = results[selectedIndex];
    if (selected) void window.sessionSearch.openQuickSearchSession(selected.sessionKey);
  };

  return (
    <main
      className="quick-search-shell"
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((index) => Math.min(results.length - 1, index + 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedIndex((index) => Math.max(0, index - 1));
        } else if (event.key === "Enter") {
          event.preventDefault();
          openSelected();
        } else if (event.key === "Escape") {
          window.close();
        }
      }}
    >
      <div className="quick-search-input">
        <Search size={17} />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索会话…"
          aria-label="搜索会话"
        />
      </div>
      <div className="quick-search-results">
        {results.map((session, index) => (
          <button
            type="button"
            key={session.sessionKey}
            className={index === selectedIndex ? "selected" : ""}
            onMouseEnter={() => setSelectedIndex(index)}
            onClick={() => void window.sessionSearch.openQuickSearchSession(session.sessionKey)}
          >
            <strong>{session.displayTitle}</strong>
            <span>
              {session.projectPath || "无项目路径"} · {formatRelativeTime(session.lastActivityAt)}
            </span>
          </button>
        ))}
        {results.length === 0 ? <p>{trimmedQuery ? "没有匹配的会话" : "输入关键词快速查找会话"}</p> : null}
      </div>
    </main>
  );
}
