import { useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SessionMatchHit, SessionSearchResult, SessionSortBy } from "../../../../core/types";
import { localize, type LanguageMode } from "../../language";
import type { LiveSessionState } from "../../live-filter";
import { SOURCE_LABEL } from "../../session-ui";
import { SessionRow } from "./session-row";
import { groupSessions, TIME_BUCKETS, type GroupMode } from "./group-logic";

export function GroupedResults({
  sessions,
  groupMode,
  sortBy,
  selectedKey,
  liveStateFor,
  language,
  onSelect,
  onOpen,
  onOpenMatch,
  onRename,
  onFavorite,
  onContextMenu,
}: {
  sessions: SessionSearchResult[];
  groupMode: GroupMode;
  sortBy: SessionSortBy;
  selectedKey: string | null;
  liveStateFor: (session: SessionSearchResult) => LiveSessionState;
  language: LanguageMode;
  onSelect: (sessionKey: string) => void;
  onOpen: (session: SessionSearchResult) => void;
  onOpenMatch: (session: SessionSearchResult, hit: SessionMatchHit) => void;
  onRename: (session: SessionSearchResult) => void;
  onFavorite: (session: SessionSearchResult) => void;
  onContextMenu: (event: ReactMouseEvent, session: SessionSearchResult) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const groups = groupSessions(sessions, groupMode);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  function toggleGroup(key: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (groupMode === "flat") {
    return (
      <div className="grouped-results">
        {sessions.map((session) => (
          <SessionRow
            key={session.sessionKey}
            session={session}
            sortBy={sortBy}
            selected={session.sessionKey === selectedKey}
            liveState={liveStateFor(session)}
            language={language}
            onSelect={onSelect}
            onOpen={onOpen}
            onOpenMatch={onOpenMatch}
            onRename={onRename}
            onFavorite={onFavorite}
            onContextMenu={onContextMenu}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="grouped-results">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key);
        return (
          <section key={group.key} className="result-group">
            <button className="result-group-head" onClick={() => toggleGroup(group.key)}>
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              <span className="result-group-label">{groupLabel(group.key, groupMode, l)}</span>
              <span className="result-group-count">{group.sessions.length}</span>
            </button>
            {!isCollapsed ? (
              <div className="result-group-body">
                {group.sessions.map((session) => (
                  <SessionRow
                    key={session.sessionKey}
                    session={session}
                    sortBy={sortBy}
                    selected={session.sessionKey === selectedKey}
                    liveState={liveStateFor(session)}
                    language={language}
                    onSelect={onSelect}
                    onOpen={onOpen}
                    onOpenMatch={onOpenMatch}
                    onRename={onRename}
                    onFavorite={onFavorite}
                    onContextMenu={onContextMenu}
                  />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function groupLabel(
  key: string,
  mode: GroupMode,
  l: (en: string, zh: string) => string,
): string {
  if (mode === "time") {
    const index = TIME_BUCKETS.indexOf(key as (typeof TIME_BUCKETS)[number]);
    if (index === 0) return l("Today", "今天");
    if (index === 1) return l("Yesterday", "昨天");
    if (index === 2) return l("This week", "本周");
    return l("Older", "更早");
  }
  if (mode === "source") {
    return SOURCE_LABEL[key as keyof typeof SOURCE_LABEL] ?? key;
  }
  // project: show the basename of the path
  const parts = key.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : key;
}
