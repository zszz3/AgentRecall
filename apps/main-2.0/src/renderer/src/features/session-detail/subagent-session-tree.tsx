import { useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown, ChevronRight, CornerUpLeft } from "lucide-react";
import type {
  SessionFamily,
  SubagentSessionNode,
  SubagentSessionSummary,
} from "../../../../core/storage/types";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { AgentIcon } from "../sessions/agent-icon";

/**
 * The parent and subagent Sessions of the open Session. Subagents stay folded behind their count:
 * an agent can start dozens of them, and listing them all would push the conversation off screen.
 */
export function SubagentSessionTree({
  family,
  language,
  onOpen,
  loadFailed = false,
  onRetry,
}: {
  family: SessionFamily;
  language: LanguageMode;
  onOpen: (sessionKey: string) => void;
  loadFailed?: boolean;
  onRetry?: () => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (!family.parent && family.children.length === 0 && !family.truncated && !loadFailed) return null;

  const toggle = (sessionKey: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sessionKey)) next.delete(sessionKey);
      else next.add(sessionKey);
      return next;
    });
  };

  return (
    <section className="subagent-session-tree">
      {loadFailed ? (
        <div className="subagent-load-error" role="alert">
          <span>{l("Failed to load subagents", "Subagent 加载失败")}</span>
          {onRetry ? (
            <button type="button" onClick={onRetry}>
              {l("Retry", "重试")}
            </button>
          ) : null}
        </div>
      ) : null}
      {family.parent ? (
        <div className="subagent-parent">
          <span className="subagent-relation-label">
            <CornerUpLeft size={13} />
            {family.parentOriginTurnIndex === null || family.parentOriginTurnIndex === undefined
              ? l("Parent session", "父会话")
              : l(
                  `Parent session · started in Turn ${family.parentOriginTurnIndex + 1}`,
                  `父会话 · 由第 ${family.parentOriginTurnIndex + 1} 轮发起`,
                )}
          </span>
          <SessionSummaryButton session={family.parent} language={language} onOpen={onOpen} />
        </div>
      ) : null}

      {family.children.length > 0 ? (
        <>
          <button
            type="button"
            className="subagent-tree-head"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{l("Subagent sessions", "子 Agent 会话")}</span>
            <small>{family.children.length}{family.truncated ? "+" : ""}</small>
          </button>
          {open ? (
            <div className="subagent-tree-list">
              {family.children.map((node) => (
                <SubagentTreeNode
                  key={node.sessionKey}
                  node={node}
                  expanded={expanded}
                  language={language}
                  onOpen={onOpen}
                  onToggle={toggle}
                />
              ))}
              {family.truncated ? (
                <p className="subagent-tree-truncated">
                  {l("More subagent sessions are not shown.", "还有更多子会话未展示")}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function SubagentTreeNode({
  node,
  expanded,
  language,
  onOpen,
  onToggle,
}: {
  node: SubagentSessionNode;
  expanded: ReadonlySet<string>;
  language: LanguageMode;
  onOpen: (sessionKey: string) => void;
  onToggle: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.sessionKey);
  const toggleLabel = isExpanded
    ? l(`Collapse child sessions of ${node.title}`, `收起${node.title}的子会话`)
    : l(`Expand child sessions of ${node.title}`, `展开${node.title}的子会话`);

  return (
    <div className="subagent-tree-node">
      <div className="subagent-tree-row">
        {hasChildren ? (
          <button
            type="button"
            className="subagent-tree-toggle"
            aria-label={toggleLabel}
            aria-expanded={isExpanded}
            onClick={() => onToggle(node.sessionKey)}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="subagent-tree-toggle-spacer" />
        )}
        <SessionSummaryButton session={node} language={language} onOpen={onOpen} />
      </div>
      {hasChildren && isExpanded ? (
        <div className="subagent-tree-children">
          {node.children.map((child) => (
            <SubagentTreeNode
              key={child.sessionKey}
              node={child}
              expanded={expanded}
              language={language}
              onOpen={onOpen}
              onToggle={onToggle}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SessionSummaryButton({
  session,
  language,
  onOpen,
}: {
  session: SubagentSessionSummary;
  language: LanguageMode;
  onOpen: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const startedIn = session.originTurnIndex === null || session.originTurnIndex === undefined
    ? null
    : l(`Turn ${session.originTurnIndex + 1}`, `第 ${session.originTurnIndex + 1} 轮`);
  return (
    <button
      type="button"
      className="subagent-session-card"
      title={session.aiSummary ? `${session.title}\n\n${session.aiSummary}` : session.title}
      onClick={() => onOpen(session.sessionKey)}
    >
      <AgentIcon source={session.source} size={14} />
      <strong>{session.title}</strong>
      <span className="subagent-session-meta">
        {startedIn ? <>{startedIn} · </> : null}
        {l(`${session.messageCount} msgs`, `${session.messageCount} 条`)} · {formatRelativeTime(session.lastActivityAt, language)}
      </span>
    </button>
  );
}
