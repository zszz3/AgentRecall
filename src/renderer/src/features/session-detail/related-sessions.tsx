import type { ReactElement } from "react";
import { Sparkles } from "lucide-react";
import type { RelatedSession } from "../../../../core/related-sessions";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { SOURCE_LABEL } from "../../session-ui";

export function RelatedSessions({
  related,
  language,
  onOpen,
}: {
  related: RelatedSession[];
  language: LanguageMode;
  onOpen: (sessionKey: string) => void;
}): ReactElement | null {
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (related.length === 0) return null;

  return (
    <section className="related-sessions">
      <header className="related-sessions-head">
        <Sparkles size={13} />
        <h4>{l("Related sessions", "相关会话")}</h4>
      </header>
      <div className="related-sessions-list">
        {related.map((item) => (
          <button key={item.sessionKey} className="related-session-card" onClick={() => onOpen(item.sessionKey)} title={item.title}>
            <span className="related-session-title">{item.title}</span>
            <span className="related-session-meta">
              <span className="related-session-source">{SOURCE_LABEL[item.source as keyof typeof SOURCE_LABEL] ?? item.source}</span>
              <span className="related-session-time">{formatRelativeTime(item.timestamp)}</span>
            </span>
            {item.sharedTags.length > 0 ? (
              <span className="related-session-tags">
                {item.sharedTags.slice(0, 3).map((tag) => (
                  <span key={tag} className="related-session-tag">
                    #{tag}
                  </span>
                ))}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );
}
