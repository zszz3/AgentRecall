import type { ReactElement } from "react";
import type { RemoteSessionDetailSnapshot } from "../../../../core/remote-session-sync";
import type {
  SessionSearchResult,
  SessionTurnDetail,
  SessionTurnSummary,
} from "../../../../core/types";
import type { ActionStatus } from "../../app-types";
import type { LanguageMode } from "../../language";
import type { LiveSessionState } from "../../live-filter";
import {
  isRemoteSession,
  remoteMigrationTitle,
  supportsMigrationSource,
  supportsResumeSource,
  unsupportedMigrationTitle,
} from "../../session-ui";
import { DetailPanel } from "../session-detail/detail-panel";

export interface SessionDetailsActions {
  loadTurn(session: SessionSearchResult, turnId: string): Promise<SessionTurnDetail | null>;
  closeLocal(): void;
  closeRemote(): void;
  rename(session: SessionSearchResult): void;
  addTag(session: SessionSearchResult): void;
  removeTag(session: SessionSearchResult, tagName: string): void;
  toggleFavorite(session: SessionSearchResult): void;
  summarize(session: SessionSearchResult): void;
  resume(session: SessionSearchResult): void;
  resumeInIterm(session: SessionSearchResult): void;
  migrate(session: SessionSearchResult): void;
  uploadRemote(session: SessionSearchResult): void;
  copyResume(session: SessionSearchResult): void;
  copyMarkdown(session: SessionSearchResult): void;
  exportMarkdown(session: SessionSearchResult): void;
  exportJson(session: SessionSearchResult): void;
  copyPlain(session: SessionSearchResult): void;
  deleteSession(session: SessionSearchResult): void;
  reveal(session: SessionSearchResult): void;
}

export function SessionDetails({
  detail,
  remoteDetail,
  turns,
  turnsLoading,
  matchedTurnId,
  actionStatus,
  query,
  liveState,
  language,
  revealLabel,
  showItermAction,
  summarizing,
  actions,
}: {
  detail: SessionSearchResult | null;
  remoteDetail: { snapshot: RemoteSessionDetailSnapshot; query: string } | null;
  turns: SessionTurnSummary[];
  turnsLoading: boolean;
  matchedTurnId: string | null;
  actionStatus: ActionStatus | null;
  query: string;
  liveState: LiveSessionState;
  language: LanguageMode;
  revealLabel: string;
  showItermAction: boolean;
  summarizing: boolean;
  actions: SessionDetailsActions;
}): ReactElement | null {
  const l = (en: string, zh: string): string => language === "zh" ? zh : en;
  if (detail) {
    const canMigrate = !isRemoteSession(detail) && supportsMigrationSource(detail.source);
    const migrationTitle = isRemoteSession(detail)
      ? remoteMigrationTitle(language)
      : canMigrate
        ? l("Migrate session to…", "迁移会话到…")
        : unsupportedMigrationTitle(language);
    return (
      <DetailPanel
        session={detail}
        turns={turns}
        turnsLoading={turnsLoading}
        matchedTurnId={matchedTurnId}
        onLoadTurn={(turnId) => actions.loadTurn(detail, turnId)}
        messages={[]}
        matchedContextMessages={[]}
        matchedMessageIndex={null}
        traceEvents={[]}
        loading={false}
        actionStatus={actionStatus}
        query={query}
        liveState={liveState}
        language={language}
        messagePageSize={0}
        olderMessageCount={0}
        revealLabel={revealLabel}
        showItermAction={showItermAction && detail.source !== "codex-app"}
        onClose={actions.closeLocal}
        onShowMore={() => undefined}
        onRename={() => actions.rename(detail)}
        onAddTag={() => actions.addTag(detail)}
        onRemoveTag={(tagName) => actions.removeTag(detail, tagName)}
        onFavorite={() => actions.toggleFavorite(detail)}
        onSummarize={() => actions.summarize(detail)}
        summarizing={summarizing}
        canResume={supportsResumeSource(detail.source)}
        canMigrate={canMigrate}
        migrationTitle={migrationTitle}
        onResume={() => actions.resume(detail)}
        onResumeIterm={() => actions.resumeInIterm(detail)}
        onMigrate={() => actions.migrate(detail)}
        onUploadRemote={() => actions.uploadRemote(detail)}
        remoteUploadDisabled={detail.source === "zcode-cli" || detail.environmentKind === "wsl"}
        onCopyResume={() => actions.copyResume(detail)}
        onCopyMarkdown={() => actions.copyMarkdown(detail)}
        onExportMarkdown={() => actions.exportMarkdown(detail)}
        onExportJson={() => actions.exportJson(detail)}
        onCopyPlain={() => actions.copyPlain(detail)}
        onDelete={() => actions.deleteSession(detail)}
        onReveal={() => actions.reveal(detail)}
      />
    );
  }

  if (!remoteDetail) return null;
  return (
    <DetailPanel
      session={remoteDetail.snapshot.session}
      turns={null}
      turnsLoading={false}
      matchedTurnId={null}
      onLoadTurn={async () => null}
      messages={remoteDetail.snapshot.messages}
      matchedContextMessages={[]}
      matchedMessageIndex={null}
      traceEvents={remoteDetail.snapshot.traceEvents}
      loading={false}
      actionStatus={null}
      query={remoteDetail.query}
      liveState="closed"
      language={language}
      messagePageSize={0}
      olderMessageCount={0}
      revealLabel={revealLabel}
      showItermAction={false}
      backdropClassName="remote-detail-backdrop"
      onClose={actions.closeRemote}
      onShowMore={() => undefined}
      onRename={() => undefined}
      onAddTag={() => undefined}
      onRemoveTag={() => undefined}
      onFavorite={() => undefined}
      onSummarize={() => undefined}
      summarizing={false}
      canResume={false}
      canMigrate={false}
      migrationTitle={l(
        "Use Restore from the remote session list.",
        "请从远程会话列表点击恢复。",
      )}
      onResume={() => undefined}
      onResumeIterm={() => undefined}
      onMigrate={() => undefined}
      onCopyResume={() => undefined}
      onCopyMarkdown={() => undefined}
      onExportMarkdown={() => undefined}
      onExportJson={() => undefined}
      onCopyPlain={() => undefined}
      onDelete={() => undefined}
      onReveal={() => undefined}
      readOnly
    />
  );
}
