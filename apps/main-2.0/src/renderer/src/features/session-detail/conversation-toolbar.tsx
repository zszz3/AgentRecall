import type { ReactElement } from "react";
import { Eye, EyeOff } from "lucide-react";
import { localize, type LanguageMode } from "../../language";
import type { ConversationRoleFilter } from "./conversation-timeline";

const CONVERSATION_ROLE_FILTERS: ConversationRoleFilter[] = ["all", "user", "assistant"];

function conversationRoleFilterLabel(filter: ConversationRoleFilter, language: LanguageMode): string {
  if (filter === "all") return localize(language, "All", "全部");
  if (filter === "user") return localize(language, "User", "用户");
  return localize(language, "Assistant", "助手");
}

/**
 * Conversation heading with the role filter and tool-call visibility toggle.
 * `turnCount` is null for the full-conversation view and the Turn count otherwise.
 */
export function ConversationToolbar({
  turnCount,
  turnsLoading,
  roleFilter,
  showTools,
  language,
  onRoleFilterChange,
  onToggleTools,
}: {
  turnCount: number | null;
  turnsLoading: boolean;
  roleFilter: ConversationRoleFilter;
  showTools: boolean;
  language: LanguageMode;
  onRoleFilterChange: (filter: ConversationRoleFilter) => void;
  onToggleTools: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="detail-timeline-toolbar">
      <div className="detail-timeline-heading">
        <h3>{turnCount !== null ? l("Turns", "对话轮次") : l("Full Conversation", "完整会话")}</h3>
        {turnCount !== null && !turnsLoading ? (
          <span className="turn-count">{l(`${turnCount} Turns`, `${turnCount} 轮`)}</span>
        ) : null}
      </div>
      <div className="conversation-filters">
        <div className="conversation-role-filter" role="group" aria-label={l("Conversation role filter", "会话角色过滤")}>
          {CONVERSATION_ROLE_FILTERS.map((filter) => (
            <button
              key={filter}
              className={roleFilter === filter ? "active" : ""}
              onClick={() => onRoleFilterChange(filter)}
              aria-pressed={roleFilter === filter}
            >
              {conversationRoleFilterLabel(filter, language)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`conversation-tools-toggle ${showTools ? "active" : ""}`}
          onClick={onToggleTools}
          aria-pressed={showTools}
          aria-label={showTools ? l("Hide tool calls", "隐藏工具调用") : l("Show tool calls", "显示工具调用")}
        >
          {showTools ? <Eye size={14} /> : <EyeOff size={14} />}
          <span>{l("Tool calls", "工具调用")}</span>
          <strong aria-live="polite">{showTools ? l("Shown", "已显示") : l("Hidden", "已隐藏")}</strong>
        </button>
      </div>
    </div>
  );
}
