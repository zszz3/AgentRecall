import { useState } from "react";
import type { ReactElement } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
} from "lucide-react";
import type {
  SessionFamily,
  SubagentSessionNode,
  SubagentSessionSummary,
} from "../../../../core/session-family";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { SOURCE_LABEL } from "../../session-ui";

export function SubagentSessionTree({
  family,
  language,
  onOpen,
}: {
  family: SessionFamily;
  language: LanguageMode;
  onOpen: (sessionKey: string) => void;
}): ReactElement | null {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (!family.parent && family.children.length === 0 && !family.truncated) return null;

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
      {family.parent ? (
        <div className="subagent-parent">
          <span className="subagent-relation-label">
            <CornerUpLeft size={13} />
            {l("Parent session", "父会话")}
          </span>
          <SessionSummaryButton
            session={family.parent}
            language={language}
            onOpen={onOpen}
          />
        </div>
      ) : null}

      {family.children.length > 0 ? (
        <>
          <header className="subagent-tree-head">
            <Bot size={14} />
            <h4>{l("Subagent sessions", "子 Agent 会话")}</h4>
          </header>
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
          </div>
        </>
      ) : null}

      {family.truncated ? (
        <p className="subagent-tree-truncated">
          {l("More subagent sessions are not shown.", "还有更多子会话未展示")}
        </p>
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
  const source = SOURCE_LABEL[session.source as keyof typeof SOURCE_LABEL] ?? session.source;
  return (
    <button
      type="button"
      className="subagent-session-card"
      title={session.title}
      onClick={() => onOpen(session.sessionKey)}
    >
      <strong>{session.title}</strong>
      <span className="subagent-session-meta">
        {source} · {session.environmentLabel} ·{" "}
        {l(`${session.messageCount} messages`, `${session.messageCount} 条消息`)} ·{" "}
        {formatRelativeTime(session.lastActivityAt)}
      </span>
      {session.aiSummary ? <span className="subagent-session-summary">{session.aiSummary}</span> : null}
    </button>
  );
}
