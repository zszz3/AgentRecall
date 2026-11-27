import { Suspense, lazy, type Dispatch, type ReactElement, type SetStateAction } from "react";
import type { MigrationTargetSettings } from "../../../../core/migration-targets";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { SessionSyncHookStatus } from "../../../../core/session-sync-queue";
import type { SessionEnvironment } from "../../../../core/types";
import type { TeamPushDraft } from "../../../../shared/team-push";
import { ActionToast } from "../../components/action-toast";
import { AiAssistantDialog } from "../../components/ai-assistant-dialog";
import { BulkDeleteDialog, CommandDialog, DeleteSessionDialog, DeleteTagDialog } from "../../components/session-dialogs";
import { SessionMigrationDialog, SessionMigrationLaunchFailedDialog } from "../../components/session-migration-dialog";
import { reduceIndexFeedback } from "../../index-status-feedback";
import type { LanguageMode } from "../../language";
import type { MessageFontSizeScale } from "../../message-font-size";
import {
  canMigrateSession,
  migrationAgentLabel,
  migrationTargetsForSession,
  resumeActionLabel,
  resumeRouteMessage,
  supportsOpenAppSource,
  supportsResumeSource,
} from "../../session-ui";
import type { ThemeMode } from "../../theme";
import { RemoteSessionsDialog } from "../remote-sessions/remote-sessions-dialog";
import type { useRemoteSessionsCache } from "../remote-sessions/use-remote-sessions-cache";
import { SettingsDialog, type SettingsSection } from "../settings/settings-dialog";
import { SshEnvironmentDialog } from "../settings/ssh-environment-dialog";
import type { useAppSettings } from "../settings/use-app-settings";
import type { useAppUpdate } from "../settings/use-app-update";
import type { useEnvironmentActions } from "../settings/use-environment-actions";
import { WslEnvironmentDialog } from "../settings/wsl-environment-dialog";
import { showTransientSuccess } from "../status/status-messages";
import { SessionContextMenu } from "./session-context-menu";
import type { useBulkSessionDelete } from "./use-bulk-session-delete";
import type { useSessionActions } from "./use-session-actions";
import type { useSessionDelete } from "./use-session-delete";
import type { useSessionDetail } from "./use-session-detail";
import type { useSessionMigration } from "./use-session-migration";

const TeamUploadDialog = lazy(() =>
  import("../team-workspace/team-upload-dialog").then((module) => ({ default: module.TeamUploadDialog })));

const DEFAULT_MIGRATION_TARGET_SETTINGS = {
  includeAntigravityCli: false,
  includeTclaude: false,
  includeTcodex: false,
} satisfies MigrationTargetSettings;

export interface SessionOverlaysHostProps {
  platform: NodeJS.Platform;
  language: LanguageMode;
  revealLabel: string;
  showMacActions: boolean;
  t: (en: string, zh: string) => string;
  tags: string[];
  environments: SessionEnvironment[];
  appSettings: AppSettings | null;
  sessionDetail: ReturnType<typeof useSessionDetail>;
  sessionActions: ReturnType<typeof useSessionActions>;
  load: () => Promise<void>;
  loadSidebarMetadata: () => Promise<void>;
  teamPushDrafts: TeamPushDraft[];
  setTeamPushDrafts: Dispatch<SetStateAction<TeamPushDraft[]>>;
  teamUploadKeys: string[] | null;
  setTeamUploadKeys: Dispatch<SetStateAction<string[] | null>>;
  sessionDelete: ReturnType<typeof useSessionDelete>;
  bulkDelete: ReturnType<typeof useBulkSessionDelete>;
  migration: ReturnType<typeof useSessionMigration>;
  remoteSessions: ReturnType<typeof useRemoteSessionsCache>;
  appUpdate: ReturnType<typeof useAppUpdate>;
  environmentActions: ReturnType<typeof useEnvironmentActions>;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  settingsInitialSection: SettingsSection;
  setSettingsInitialSection: (section: SettingsSection) => void;
  settingsFeedback: ReturnType<typeof useAppSettings>["feedback"];
  updateSettings: (update: AppSettingsUpdate) => Promise<void>;
  importV1Data: ReturnType<typeof useAppSettings>["importV1Data"];
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  setLanguage: (language: LanguageMode) => void;
  messageFontSize: MessageFontSizeScale;
  setMessageFontSize: (scale: MessageFontSizeScale) => void;
  sessionHookStatus: SessionSyncHookStatus | null;
  sessionHookBusy: boolean;
  toggleSessionSyncHook: (enabled: boolean) => Promise<void>;
  gatewayBuiltInModelLabel: string | null;
  onOpenProviders: () => void;
  onOpenAgentModel: () => void;
  sshDialogOpen: boolean;
  setSshDialogOpen: (open: boolean) => void;
  wslDialogOpen: boolean;
  setWslDialogOpen: (open: boolean) => void;
  remoteSessionsOpen: boolean;
  setRemoteSessionsOpen: (open: boolean) => void;
  aiAssistantOpen: boolean;
  setAiAssistantOpen: (open: boolean) => void;
}

export function SessionOverlaysHost(props: SessionOverlaysHostProps): ReactElement {
  const {
    platform,
    language,
    revealLabel,
    showMacActions,
    t,
    tags,
    environments,
    appSettings,
    sessionDetail,
    sessionActions,
    load,
    loadSidebarMetadata,
    teamPushDrafts,
    setTeamPushDrafts,
    teamUploadKeys,
    setTeamUploadKeys,
    sessionDelete,
    bulkDelete,
    migration,
    remoteSessions,
    appUpdate,
    environmentActions,
    settingsOpen,
    setSettingsOpen,
    settingsInitialSection,
    setSettingsInitialSection,
    settingsFeedback,
    updateSettings,
    importV1Data,
    theme,
    setTheme,
    setLanguage,
    messageFontSize,
    setMessageFontSize,
    sessionHookStatus,
    sessionHookBusy,
    toggleSessionSyncHook,
    gatewayBuiltInModelLabel,
    onOpenProviders,
    onOpenAgentModel,
    sshDialogOpen,
    setSshDialogOpen,
    wslDialogOpen,
    setWslDialogOpen,
    remoteSessionsOpen,
    setRemoteSessionsOpen,
    aiAssistantOpen,
    setAiAssistantOpen,
  } = props;

  const {
    contextMenu,
    setContextMenu,
    dialog,
    setDialog,
    deleteTagName,
    setDeleteTagName,
    actionStatus,
    setActionStatus,
    refreshFeedback,
    setRefreshFeedback,
    beginRename,
    beginAddTag,
    submitDialog,
    deleteTagGlobally,
    runAction,
    exportMarkdown,
    exportJson,
    continueRemoteSessionsInBackground,
  } = sessionActions;
  const migrationDialog = migration.dialog;
  const bulkDeleteDialog = bulkDelete.dialog;

  return (
    <>
      {teamUploadKeys !== null && (
        <Suspense fallback={<p role="status">{t("Opening upload…", "正在打开上传窗口…")}</p>}>
          <TeamUploadDialog
            language={language}
            drafts={teamPushDrafts.filter((draft) => teamUploadKeys.includes(draft.item.key))}
            onClose={() => setTeamUploadKeys(null)}
            onPushed={(keys) => setTeamPushDrafts((previous) => previous.filter((draft) => !keys.includes(draft.item.key)))}
            onOpenSettings={() => {
              setTeamUploadKeys(null);
              setSettingsInitialSection("team");
              setSettingsOpen(true);
            }}
          />
        </Suspense>
      )}

      {contextMenu ? (
        <SessionContextMenu
          state={contextMenu}
          language={language}
          revealLabel={revealLabel}
          showMacActions={showMacActions}
          canResume={supportsResumeSource(contextMenu.session.source)}
          canOpenApp={supportsOpenAppSource(contextMenu.session.source)}
          canStepcodeResume={Boolean(
            appSettings?.includeStepcode
            && contextMenu.session.environmentKind === "local"
            && (
              contextMenu.session.source === "claude-cli"
              || contextMenu.session.source === "claude-app"
              || contextMenu.session.source === "stepcode-claude"
              || contextMenu.session.source === "codex-cli"
              || contextMenu.session.source === "codex-app"
              || contextMenu.session.source === "stepcode-codex"
            ),
          )}
          canMigrate={canMigrateSession(contextMenu.session, appSettings ?? DEFAULT_MIGRATION_TARGET_SETTINGS)}
          onShareTeam={() => {
            const session = contextMenu.session;
            const draft: TeamPushDraft = {
              item: { kind: "session", key: `session:${session.sessionKey}`, sessionKey: session.sessionKey },
              title: session.displayTitle || session.originalTitle,
              subtitle: t("Full session snapshot", "完整会话快照"),
            };
            setTeamPushDrafts((previous) => [...previous.filter((item) => item.item.key !== draft.item.key), draft]);
            setContextMenu(null);
            setTeamUploadKeys([draft.item.key]);
          }}
          onRename={() => beginRename(contextMenu.session)}
          onAddTag={() => beginAddTag(contextMenu.session)}
          onSelectMultiple={() => bulkDelete.begin(contextMenu.session.sessionKey)}
          onFavorite={() =>
            void runAction(
              contextMenu.session.favorited ? t("Removing favorite", "正在取消收藏") : t("Adding favorite", "正在加入收藏"),
              () => window.sessionSearch.setFavorited(contextMenu.session.sessionKey, !contextMenu.session.favorited),
              contextMenu.session.favorited ? t("Removed from favorites.", "已取消收藏。") : t("Added to favorites.", "已加入收藏。"),
            )
          }
          onHide={() =>
            void runAction(
              t("Updating visibility", "正在更新可见性"),
              () => window.sessionSearch.setHidden(contextMenu.session.sessionKey, !contextMenu.session.hidden),
              t("Visibility updated.", "可见性已更新。"),
            )
          }
          onResume={() =>
            void runAction(
              resumeActionLabel(contextMenu.session.source, language),
              () => window.sessionSearch.resumeSession(contextMenu.session.sessionKey),
              (result) => resumeRouteMessage(result, language),
            )
          }
          onStepcodeResume={() =>
            void runAction(
              t("Opening StepCode", "正在通过 StepCode 恢复"),
              () => window.sessionSearch.resumeSessionWithStepcode(contextMenu.session.sessionKey),
              t("StepCode resume command sent to terminal.", "StepCode 恢复命令已发送到终端。"),
            )
          }
          onResumeIterm={() =>
            void runAction(
              t("Opening iTerm", "正在打开 iTerm"),
              () => window.sessionSearch.resumeSessionInIterm(contextMenu.session.sessionKey),
              t("Resume command sent to iTerm.", "Resume 命令已发送到 iTerm。"),
            )
          }
          onOpenApp={() =>
            void runAction(
              contextMenu.session.source === "codex-app" ? resumeActionLabel("codex-app", language) : t("Opening native app", "正在打开原生应用"),
              () => window.sessionSearch.openNativeApp(contextMenu.session.sessionKey),
              contextMenu.session.source === "codex-app" ? resumeRouteMessage({ route: "app" }, language) : t("Native app opened.", "原生应用已打开。"),
            )
          }
          onMigrate={() => migration.begin(contextMenu.session)}
          onCopyResume={() =>
            void runAction(
              t("Copying resume command", "正在复制 Resume 命令"),
              () => window.sessionSearch.copyResumeCommand(contextMenu.session.sessionKey),
              t("Resume command copied.", "Resume 命令已复制。"),
            )
          }
          onCopyMarkdown={() =>
            void runAction(
              t("Copying markdown", "正在复制 Markdown"),
              () => window.sessionSearch.copyMarkdown(contextMenu.session.sessionKey),
              t("Markdown copied.", "Markdown 已复制。"),
            )
          }
          onExportMarkdown={(includeToolTrace) => void exportMarkdown(contextMenu.session.sessionKey, includeToolTrace)}
          onExportJson={() => void exportJson(contextMenu.session.sessionKey)}
          onDelete={() => sessionDelete.requestDelete(contextMenu.session)}
          onReveal={() =>
            void runAction(
              `Opening ${revealLabel}`,
              () => window.sessionSearch.revealSession(contextMenu.session.sessionKey),
              `${revealLabel} opened.`,
            )
          }
        />
      ) : null}

      {migrationDialog?.kind === "select" ? (
        <SessionMigrationDialog
          session={migrationDialog.session}
          targets={migrationTargetsForSession(migrationDialog.session, appSettings ?? DEFAULT_MIGRATION_TARGET_SETTINGS)}
          environments={environments}
          language={language}
          busy={migration.busy}
          progress={migration.progress}
          throughTurnIndex={migrationDialog.throughTurnIndex}
          onSelect={(target, withoutProjectPath, targetEnvironmentId, targetProjectPath) =>
            void migration.run(target, withoutProjectPath, targetEnvironmentId, targetProjectPath)}
          onClose={migration.close}
        />
      ) : null}

      {migrationDialog?.kind === "launch-failed" ? (
        <SessionMigrationLaunchFailedDialog
          session={migrationDialog.session}
          result={migrationDialog.result}
          language={language}
          onClose={migration.close}
        />
      ) : null}

      {actionStatus
        ? <ActionToast status={actionStatus} onClose={() => setActionStatus(null)} />
        : refreshFeedback
          ? (
              <ActionToast
                status={refreshFeedback}
                onClose={() => setRefreshFeedback((current) => reduceIndexFeedback(current, { type: "dismiss" }))}
              />
            )
          : null}

      {dialog ? (
        <CommandDialog
          dialog={dialog}
          tags={tags}
          language={language}
          onChange={(value) => setDialog(dialog.kind === "rename"
            ? { ...dialog, value, useDefaultTitle: false }
            : { ...dialog, value })}
          onRestoreDefault={() => {
            if (dialog.kind !== "rename") return;
            setDialog({
              ...dialog,
              value: dialog.session.originalTitle || dialog.session.firstQuestion || "",
              useDefaultTitle: true,
            });
          }}
          onSubmit={(value) => void submitDialog(value)}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {deleteTagName ? (
        <DeleteTagDialog
          tagName={deleteTagName}
          language={language}
          onConfirm={() => void deleteTagGlobally(deleteTagName)}
          onCancel={() => setDeleteTagName(null)}
        />
      ) : null}

      {sessionDelete.request ? (
        <DeleteSessionDialog
          session={sessionDelete.request.session}
          cascadeCount={sessionDelete.request.cascadeCount}
          hasLiveSession={sessionDelete.request.hasLiveSession}
          liveSessionCheckFailed={sessionDelete.request.liveCheckFailed}
          confirmationVersion={sessionDelete.request.version}
          isOpen={sessionDetail.detail?.sessionKey === sessionDelete.request.session.sessionKey}
          blockedMessage={sessionDelete.request.blockedMessage}
          language={language}
          deleting={sessionDelete.deleting}
          onConfirm={() => void sessionDelete.confirm()}
          onCancel={() => {
            if (sessionDelete.deleting) return;
            sessionDelete.cancel();
            sessionDetail.closeLocal();
          }}
        />
      ) : null}

      {bulkDeleteDialog ? (
        <BulkDeleteDialog
          mode={bulkDeleteDialog.mode}
          preview={bulkDeleteDialog.preview}
          dateValue={bulkDeleteDialog.dateValue}
          favoriteCount={bulkDeleteDialog.favoriteCount}
          busy={bulkDelete.busy}
          language={language}
          onDateChange={bulkDelete.changeDate}
          onPreview={() => void bulkDelete.previewDateCleanup()}
          onConfirm={(confirmed) => void bulkDelete.confirm(confirmed)}
          onCancel={bulkDelete.closeDialog}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          platform={platform}
          initialSection={settingsInitialSection}
          settings={appSettings}
          appUpdateStatus={appUpdate.status}
          appUpdateProgress={appUpdate.progress}
          appUpdateBusy={appUpdate.busy}
          appUpdateError={appUpdate.error}
          environments={environments}
          environmentHealthReports={environmentActions.healthReports}
          diagnosingEnvironmentId={environmentActions.diagnosingId}
          theme={theme}
          language={language}
          messageFontSize={messageFontSize}
          feedback={settingsFeedback}
          onSettingsChange={updateSettings}
          onCheckAppUpdate={() => void appUpdate.check()}
          onInstallAppUpdate={() => void appUpdate.install()}
          onSkipAppUpdate={(untilNextVersion) => void appUpdate.skip(untilNextVersion)}
          onThemeChange={setTheme}
          onLanguageChange={setLanguage}
          onMessageFontSizeChange={setMessageFontSize}
          sessionHookStatus={sessionHookStatus}
          sessionHookBusy={sessionHookBusy}
          onSessionHookChange={(enabled) => void toggleSessionSyncHook(enabled)}
          onRefreshEnvironment={(environment) => void environmentActions.refresh(environment)}
          onDiagnoseEnvironment={(environment) => void environmentActions.diagnose(environment)}
          onDeleteEnvironment={(environment) => void environmentActions.remove(environment)}
          onAddSsh={() => setSshDialogOpen(true)}
          onAddWsl={() => setWslDialogOpen(true)}
          onImportV1={importV1Data}
          onOpenApiConfig={() => {
            setSettingsOpen(false);
            onOpenProviders();
          }}
          onOpenAgentModel={() => {
            setSettingsOpen(false);
            onOpenAgentModel();
          }}
          gatewayModelLabel={gatewayBuiltInModelLabel}
          onOpenRemoteSessions={() => {
            setSettingsOpen(false);
            setRemoteSessionsOpen(true);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {sshDialogOpen ? (
        <SshEnvironmentDialog
          environments={environments}
          language={language}
          feedback={settingsFeedback}
          onSaveEnvironment={environmentActions.save}
          onClose={() => setSshDialogOpen(false)}
        />
      ) : null}

      {wslDialogOpen ? (
        <WslEnvironmentDialog
          environments={environments}
          language={language}
          feedback={settingsFeedback}
          onSaveEnvironment={environmentActions.save}
          onClose={() => setWslDialogOpen(false)}
        />
      ) : null}

      {remoteSessionsOpen ? (
        <RemoteSessionsDialog
          cache={remoteSessions.cache}
          language={language}
          onRefresh={remoteSessions.refresh}
          onQueueUploads={remoteSessions.queueUploads}
          onQueueDeletions={remoteSessions.queueDeletions}
          onContinueInBackground={continueRemoteSessionsInBackground}
          onRestored={(result) => {
            const message = result.launched
              ? t(
                  `Restored and opened in ${migrationAgentLabel(result.target)}.`,
                  `已恢复并在 ${migrationAgentLabel(result.target)} 中打开。`,
                )
              : result.warning || result.resumeCommand;
            // Migration progress is delivered over a separate IPC channel and
            // its final "launching" event can arrive just after the restore
            // invoke resolves. Finish on the next task so that stale progress
            // cannot overwrite the terminal status.
            window.setTimeout(() => {
              migration.clearProgress();
              if (result.launched) showTransientSuccess(setActionStatus, message);
              else setActionStatus({ kind: "error", message });
            }, 0);
            void Promise.all([load(), loadSidebarMetadata()]);
          }}
          onOpenDetail={sessionDetail.openRemote}
          onClose={() => setRemoteSessionsOpen(false)}
        />
      ) : null}

      {aiAssistantOpen ? (
        <AiAssistantDialog
          language={language}
          onOpenSession={(session) => {
            setAiAssistantOpen(false);
            void sessionDetail.openLocal(session);
          }}
          onClose={() => setAiAssistantOpen(false)}
        />
      ) : null}
    </>
  );
}
