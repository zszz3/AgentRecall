import type { Dispatch, ReactElement, SetStateAction } from "react";
import type { SessionSearchResult } from "../../../../core/types";
import type { TeamPushDraft } from "../../../../shared/team-push";
import type { ActionStatus } from "../../app-types";
import type { AppPage } from "../../components/app-navigation";
import type { LanguageMode } from "../../language";
import { getLiveSessionState } from "../../live-filter";
import { resumeActionLabel, resumeRouteMessage } from "../../session-ui";
import type { PageRequest } from "../navigation/use-page-navigation";
import { SessionDetails } from "./session-details";
import type { useSessionActions } from "./use-session-actions";
import type { useSessionDetail } from "./use-session-detail";
import type { useSessionMigration } from "./use-session-migration";

export interface SessionDetailHostProps {
  sessionDetail: ReturnType<typeof useSessionDetail>;
  sessionActions: ReturnType<typeof useSessionActions>;
  query: string;
  liveSessionKeys: Set<string>;
  liveDetectionFailed: boolean;
  language: LanguageMode;
  revealLabel: string;
  showItermAction: boolean;
  familyRefreshVersion: number;
  t: (en: string, zh: string) => string;
  reportSessionDetailError: (error: unknown) => void;
  onMigrate: ReturnType<typeof useSessionMigration>["begin"];
  onDeleteSession: (session: SessionSearchResult) => void;
  setTeamPushDrafts: Dispatch<SetStateAction<TeamPushDraft[]>>;
  setTeamUploadKeys: Dispatch<SetStateAction<string[] | null>>;
  navigateToPage: (page: AppPage) => Promise<boolean>;
  openPage: (request: PageRequest) => Promise<boolean>;
  setActionStatus: Dispatch<SetStateAction<ActionStatus | null>>;
}

export function SessionDetailHost(props: SessionDetailHostProps): ReactElement {
  const {
    sessionDetail,
    sessionActions,
    query,
    liveSessionKeys,
    liveDetectionFailed,
    language,
    revealLabel,
    showItermAction,
    familyRefreshVersion,
    t,
    reportSessionDetailError,
    onMigrate,
    onDeleteSession,
    setTeamPushDrafts,
    setTeamUploadKeys,
    navigateToPage,
    openPage,
    setActionStatus,
  } = props;

  return (
    <SessionDetails
      detail={sessionDetail.detail}
      remoteDetail={sessionDetail.remoteDetail}
      turns={sessionDetail.turns}
      turnsLoading={sessionDetail.turnsLoading}
      matchedTurnId={sessionDetail.matchedTurnId}
      matchedMessageIndex={sessionDetail.matchedMessageIndex}
      actionStatus={sessionActions.actionStatus}
      query={query}
      liveState={sessionDetail.detail
        ? getLiveSessionState(sessionDetail.detail, liveSessionKeys, liveDetectionFailed)
        : "closed"}
      language={language}
      revealLabel={revealLabel}
      showItermAction={showItermAction}
      summarizing={sessionActions.summarizing}
      familyRefreshVersion={familyRefreshVersion}
      actions={{
        loadTurn: sessionDetail.loadTurn,
        openFamilySession: async (sessionKey) => {
          try {
            const session = await window.sessionSearch.getSession(sessionKey);
            if (!session) {
              setActionStatus({
                kind: "error",
                message: t(
                  "This related session is no longer available. The subagent list has been refreshed.",
                  "关联会话已不存在，Subagent 列表已刷新。",
                ),
              });
              return "missing";
            }
            await sessionDetail.openLocal(session);
            return "opened";
          } catch (error) {
            reportSessionDetailError(error);
            return "failed";
          }
        },
        closeLocal: sessionDetail.closeLocal,
        closeRemote: sessionDetail.closeRemote,
        rename: sessionActions.beginRename,
        addTag: sessionActions.beginAddTag,
        removeTag: (session, tagName) => void sessionActions.removeTag(session, tagName),
        toggleFavorite: (session) => void sessionActions.toggleFavorite(session),
        summarize: (session) => void sessionActions.summarizeDetail(session),
        resume: (session) => void sessionActions.runAction(
          resumeActionLabel(session.source, language),
          () => window.sessionSearch.resumeSession(session.sessionKey),
          (result) => resumeRouteMessage(result, language),
        ),
        resumeInIterm: (session) => void sessionActions.runAction(
          t("Opening iTerm", "正在打开 iTerm"),
          () => window.sessionSearch.resumeSessionInIterm(session.sessionKey),
          t("Resume command sent to iTerm.", "Resume 命令已发送到 iTerm。"),
        ),
        migrate: onMigrate,
        shareTurns: (session, turnIds) => {
          const entries: TeamPushDraft[] = sessionDetail.turns
            .filter((turn) => turnIds.includes(turn.id))
            .map((turn) => ({
              item: { kind: "turn", key: `turn:${session.sessionKey}:${turn.id}`, sessionKey: session.sessionKey, turnId: turn.id },
              title: `${session.displayTitle || session.originalTitle} · Turn ${turn.turnIndex + 1}`,
              subtitle: turn.userPreview || turn.assistantPreview,
            }));
          setTeamPushDrafts((previous) => [
            ...previous.filter((item) => !entries.some((entry) => entry.item.key === item.item.key)),
            ...entries,
          ]);
          setTeamUploadKeys(entries.map((entry) => entry.item.key));
        },
        uploadRemote: (session) => void sessionActions.uploadRemoteSession(session),
        copyResume: (session) => void sessionActions.runAction(
          t("Copying resume command", "正在复制 Resume 命令"),
          () => window.sessionSearch.copyResumeCommand(session.sessionKey),
          t("Resume command copied.", "Resume 命令已复制。"),
        ),
        copyMarkdown: (session) => void sessionActions.runAction(
          t("Copying markdown", "正在复制 Markdown"),
          () => window.sessionSearch.copyMarkdown(session.sessionKey),
          t("Markdown copied.", "Markdown 已复制。"),
        ),
        exportMarkdown: (session, includeToolTrace) => void sessionActions.exportMarkdown(session.sessionKey, includeToolTrace),
        exportJson: (session) => void sessionActions.exportJson(session.sessionKey),
        copyPlain: (session) => void sessionActions.runAction(
          t("Copying plain text", "正在复制纯文本"),
          () => window.sessionSearch.copyPlainText(session.sessionKey),
          t("Plain text copied.", "纯文本已复制。"),
        ),
        deleteSession: onDeleteSession,
        openInvocationOwner: (invocation) => {
          sessionDetail.closeLocal();
          const owner = invocation.ownerReference;
          if (invocation.surface === "evaluation") {
            void openPage({ page: "evaluation", runId: owner.runId, caseId: owner.caseId, evaluatorId: owner.evaluatorId });
            return;
          }
          if (invocation.surface === "system") {
            void openPage({ page: "runtimes", channelId: owner.channelId });
            return;
          }
          if (invocation.surface === "agent") {
            if (owner.agentId) void openPage({ page: "runtimes", agentId: owner.agentId });
            else void navigateToPage("workbench");
            return;
          }
          if (invocation.surface === "skill") {
            void openPage({ page: "skills", discovery: true });
            return;
          }
          void navigateToPage("workbench");
        },
        reveal: (session) => void sessionActions.runAction(
          `Opening ${revealLabel}`,
          () => window.sessionSearch.revealSession(session.sessionKey),
          `${revealLabel} opened.`,
        ),
      }}
    />
  );
}
