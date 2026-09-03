import { useEffect, useState, type ReactElement } from "react";
import type { RemoteSessionDetailSnapshot } from "../../../../core/remote-session-sync";
import type { SessionFamily } from "../../../../core/session-family";
import type {
  SessionSearchResult,
  RuntimeInvocationSummary,
  SessionTurnDetail,
  SessionTurnSummary,
} from "../../../../core/types";
import type { ActionStatus } from "../../app-types";
import type { LanguageMode } from "../../language";
import type { LiveSessionState } from "../../live-filter";
import {
  canMigrateSession,
  remoteMigrationTitle,
  supportsResumeSource,
  unsupportedMigrationTitle,
} from "../../session-ui";
import { DetailPanel } from "../session-detail/detail-panel";

const EMPTY_SESSION_FAMILY: SessionFamily = {
  parent: null,
  children: [],
  truncated: false,
};

type SessionFamilyLoadState = {
  sessionKey: string | null;
  family: SessionFamily;
  status: "idle" | "loading" | "ready" | "error";
};

export interface SessionDetailsActions {
  loadTurn(session: SessionSearchResult, turnId: string): Promise<SessionTurnDetail | null>;
  openFamilySession(sessionKey: string): Promise<"opened" | "missing" | "failed">;
  closeLocal(): void;
  closeRemote(): void;
  rename(session: SessionSearchResult): void;
  addTag(session: SessionSearchResult): void;
  removeTag(session: SessionSearchResult, tagName: string): void;
  toggleFavorite(session: SessionSearchResult): void;
  summarize(session: SessionSearchResult): void;
  resume(session: SessionSearchResult): void;
  resumeInIterm(session: SessionSearchResult): void;
  migrate(session: SessionSearchResult, turn?: SessionTurnSummary): void;
  uploadRemote(session: SessionSearchResult): void;
  copyResume(session: SessionSearchResult): void;
  copyMarkdown(session: SessionSearchResult): void;
  exportMarkdown(session: SessionSearchResult, includeToolTrace: boolean): void;
  exportJson(session: SessionSearchResult): void;
  copyPlain(session: SessionSearchResult): void;
  deleteSession(session: SessionSearchResult): void;
  reveal(session: SessionSearchResult): void;
  openInvocationOwner(invocation: RuntimeInvocationSummary): void;
}

export function SessionDetails({
  detail,
  remoteDetail,
  turns,
  turnsLoading,
  matchedTurnId,
  matchedMessageIndex,
  actionStatus,
  query,
  liveState,
  language,
  revealLabel,
  showItermAction,
  summarizing,
  familyRefreshVersion,
  actions,
}: {
  detail: SessionSearchResult | null;
  remoteDetail: { snapshot: RemoteSessionDetailSnapshot; query: string } | null;
  turns: SessionTurnSummary[];
  turnsLoading: boolean;
  matchedTurnId: string | null;
  matchedMessageIndex: number | null;
  actionStatus: ActionStatus | null;
  query: string;
  liveState: LiveSessionState;
  language: LanguageMode;
  revealLabel: string;
  showItermAction: boolean;
  summarizing: boolean;
  familyRefreshVersion: number;
  actions: SessionDetailsActions;
}): ReactElement | null {
  const l = (en: string, zh: string): string => language === "zh" ? zh : en;
  const [familyState, setFamilyState] = useState<SessionFamilyLoadState>({
    sessionKey: null,
    family: EMPTY_SESSION_FAMILY,
    status: "idle",
  });
  const [familyRetryVersion, setFamilyRetryVersion] = useState(0);

  useEffect(() => {
    if (!detail) {
      setFamilyState({ sessionKey: null, family: EMPTY_SESSION_FAMILY, status: "idle" });
      return;
    }
    const sessionKey = detail.sessionKey;
    let cancelled = false;
    setFamilyState((current) => current.sessionKey === sessionKey
      ? { ...current, status: "loading" }
      : { sessionKey, family: EMPTY_SESSION_FAMILY, status: "loading" });
    void window.sessionSearch.getSessionFamily(sessionKey)
      .then((family) => {
        if (!cancelled) setFamilyState({ sessionKey, family, status: "ready" });
      })
      .catch(() => {
        if (!cancelled) {
          setFamilyState((current) => current.sessionKey === sessionKey
            ? { ...current, status: "error" }
            : current);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.sessionKey, familyRefreshVersion, familyRetryVersion]);

  if (detail) {
    const sessionFamily = familyState.sessionKey === detail.sessionKey
      ? familyState.family
      : EMPTY_SESSION_FAMILY;
    const familyLoadFailed = familyState.sessionKey === detail.sessionKey
      && familyState.status === "error";
    const canMigrate = canMigrateSession(detail);
    const migrationTitle = canMigrate
        ? l("Migrate session to…", "迁移会话到…")
        : detail.environmentKind === "ssh"
          ? remoteMigrationTitle(language)
          : unsupportedMigrationTitle(language);
    return (
      <DetailPanel
        session={detail}
        sessionFamily={sessionFamily}
        turns={turns}
        turnsLoading={turnsLoading}
        matchedTurnId={matchedTurnId}
        onLoadTurn={(turnId) => actions.loadTurn(detail, turnId)}
        onMigrateTurn={canMigrate ? (turn) => actions.migrate(detail, turn) : undefined}
        onOpenFamilySession={(sessionKey) => {
          void actions.openFamilySession(sessionKey).then((result) => {
            if (result === "missing") setFamilyRetryVersion((current) => current + 1);
          });
        }}
        sessionFamilyLoadFailed={familyLoadFailed}
        onRetrySessionFamily={() => setFamilyRetryVersion((current) => current + 1)}
        onOpenInvocationOwner={actions.openInvocationOwner}
        messages={[]}
        matchedContextMessages={[]}
        matchedMessageIndex={matchedMessageIndex}
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
        onExportMarkdown={(includeToolTrace) => actions.exportMarkdown(detail, includeToolTrace)}
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
      sessionFamily={{ parent: null, children: [], truncated: false }}
      turns={null}
      turnsLoading={false}
      matchedTurnId={null}
        onLoadTurn={async () => null}
        onMigrateTurn={undefined}
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
