import { useMemo, type ReactElement } from "react";
import type { SessionMessage } from "../../../../core/types";
import type { CoreSessionSearchResult } from "../../../../shared/core-api";
import { localize, type LanguageMode } from "../../language";
import { SOURCE_LABEL, supportsResumeSource } from "../../session-ui";
import {
  SessionDetailV1,
  type LoadOlderMessagesRequest,
  type SessionDetailMessageV1,
} from "./v1";

export interface CoreDetailActionStatus {
  kind: "error" | "running" | "success";
  message: string;
}

export interface CoreSessionDetailAdapterProps {
  actionStatus: CoreDetailActionStatus | null;
  language: LanguageMode;
  loading: boolean;
  messages: readonly SessionMessage[];
  olderMessageCount: number;
  onClose: () => void;
  onFavorite: () => void;
  onLoadOlder: (request: LoadOlderMessagesRequest) => Promise<void> | void;
  onRename: () => void;
  onResume: () => void;
  session: CoreSessionSearchResult;
}

export function CoreSessionDetailAdapter({
  actionStatus,
  language,
  loading,
  messages,
  olderMessageCount,
  onClose,
  onFavorite,
  onLoadOlder,
  onRename,
  onResume,
  session,
}: CoreSessionDetailAdapterProps): ReactElement {
  const startedAt = Number.isFinite(session.timestamp)
    ? new Date(session.timestamp).toISOString()
    : null;
  const detailMessages = useMemo<SessionDetailMessageV1[]>(
    () =>
      messages.map((message) => ({
        content: message.content,
        id: `${session.sessionKey}:${message.index}`,
        role: message.role,
        timestamp: message.timestamp,
      })),
    [messages, session.sessionKey],
  );
  const resumeLabel =
    session.source === "codex-app"
      ? localize(language, "Open in Codex", "在 Codex 中打开")
      : localize(language, "Resume", "恢复");

  return (
    <div className="detail-backdrop" onMouseDown={onClose}>
      <div className="core-detail-v1-shell" onMouseDown={(event) => event.stopPropagation()}>
        <SessionDetailV1
          key={session.sessionKey}
          canResume={supportsResumeSource(session.source)}
          hasOlderMessages={olderMessageCount > 0}
          isFavorite={session.favorited}
          isLoading={loading && detailMessages.length === 0}
          isLoadingOlder={loading && detailMessages.length > 0}
          labels={{ resume: resumeLabel }}
          language={language}
          messages={detailMessages}
          onClose={onClose}
          onLoadOlder={onLoadOlder}
          onRename={onRename}
          onResume={onResume}
          onToggleFavorite={onFavorite}
          resumePending={actionStatus?.kind === "running"}
          session={{
            id: session.sessionKey,
            messageCount: session.messageCount,
            projectPath: session.projectPath,
            sourceLabel: SOURCE_LABEL[session.source] ?? session.source,
            startedAt,
            title: session.displayTitle,
          }}
        />
        {actionStatus ? (
          <div className={`action-status core-detail-v1-status ${actionStatus.kind}`} role="status">
            {actionStatus.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}
