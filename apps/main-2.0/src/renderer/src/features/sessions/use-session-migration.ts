import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { SessionSearchApi } from "../../../../preload";
import { isLocalSessionEnvironment } from "../../../../core/session-environment";
import type {
  SessionEnvironment,
  SessionMigrationProgress,
  SessionSearchResult,
  SessionTurnSummary,
} from "../../../../core/types";
import type { ActionStatus, SessionMigrationDialogState } from "../../app-types";
import type { LanguageMode } from "../../language";
import { migrationAgentLabel } from "../../session-ui";
import { migrationProgressMessage, migrationStrategyLabel } from "./session-migration-copy";

export interface SessionMigrationController {
  dialog: SessionMigrationDialogState;
  progress: SessionMigrationProgress | null;
  busy: boolean;
  /** Opens target selection; with a Turn, migrates the conversation up to and including it. */
  begin(session: SessionSearchResult, turn?: SessionTurnSummary): void;
  close(): void;
  run(
    target: SessionMigrationProgress["target"],
    withoutProjectPath: boolean,
    targetEnvironmentId: string,
    selectedTargetProjectPath?: string,
  ): Promise<void>;
  /** Drops progress left over from a restore that reports its result separately. */
  clearProgress(): void;
}

interface SessionMigrationOptions {
  api: Pick<SessionSearchApi, "migrateSession" | "chooseLocalProjectDirectory" | "onMigrationProgress">;
  environments: readonly SessionEnvironment[];
  language: LanguageMode;
  setStatus: Dispatch<SetStateAction<ActionStatus | null>>;
  onStarted(): void;
  /** Refreshes the views after a migration; runs before the result is reported. */
  onMigrated(): Promise<void>;
  t(en: string, zh: string): string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSessionMigration({
  api,
  environments,
  language,
  setStatus,
  onStarted,
  onMigrated,
  t,
}: SessionMigrationOptions): SessionMigrationController {
  const [dialog, setDialog] = useState<SessionMigrationDialogState>(null);
  // A migration can finish after the dialog closed; the result then only updates the status line.
  const dialogRef = useRef<SessionMigrationDialogState>(null);
  const [progress, setProgress] = useState<SessionMigrationProgress | null>(null);
  const [busy, setBusy] = useState(false);
  dialogRef.current = dialog;

  useEffect(() => api.onMigrationProgress((next) => {
    setProgress(next);
    setStatus({ kind: "running", message: migrationProgressMessage(next, language) });
  }), [api, language, setStatus]);

  function begin(session: SessionSearchResult, turn?: SessionTurnSummary): void {
    onStarted();
    setDialog({
      kind: "select",
      session,
      ...(turn ? { throughTurnId: turn.id, throughTurnIndex: turn.turnIndex } : {}),
    });
  }

  const close = useCallback(() => {
    dialogRef.current = null;
    setDialog(null);
  }, []);

  async function run(
    target: SessionMigrationProgress["target"],
    withoutProjectPath: boolean,
    targetEnvironmentId: string,
    selectedTargetProjectPath?: string,
  ): Promise<void> {
    if (!dialog || dialog.kind !== "select") return;
    const { session, throughTurnId } = dialog;
    const targetEnvironment = environments.find((environment) => environment.id === targetEnvironmentId);
    let targetProjectPath: string | undefined;
    if (withoutProjectPath) {
      targetProjectPath = "";
    } else if (targetEnvironment?.kind === "wsl") {
      targetProjectPath = selectedTargetProjectPath?.trim() || undefined;
      if (!targetProjectPath) {
        setStatus({ kind: "error", message: t("Enter an absolute Linux project path or choose without a project path.", "请输入 Linux 绝对项目路径，或选择无项目路径。") });
        return;
      }
    } else if (targetEnvironment?.kind === "local" && (!isLocalSessionEnvironment(session) || !session.projectPath.trim())) {
      try {
        targetProjectPath = (await api.chooseLocalProjectDirectory()) ?? undefined;
      } catch (error) {
        setStatus({ kind: "error", message: message(error) });
        return;
      }
      if (!targetProjectPath) return;
    }
    setBusy(true);
    onStarted();
    setProgress(null);
    setStatus({ kind: "running", message: t("Preparing migration...", "正在准备迁移...") });
    try {
      const result = await api.migrateSession({
        sessionKey: session.sessionKey,
        target,
        ...(targetProjectPath !== undefined ? { targetProjectPath } : {}),
        ...(throughTurnId ? { throughTurnId } : {}),
        ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
      });
      await onMigrated();
      const strategyLabel = migrationStrategyLabel(result.strategy, language);
      const summary = t(
        `Migrated to ${migrationAgentLabel(result.target)} (${strategyLabel}): ${result.targetSessionId}`,
        `已迁移到 ${migrationAgentLabel(result.target)}（${strategyLabel}）：${result.targetSessionId}`,
      );
      const dialogStillOpen = dialogRef.current?.kind === "select";
      const backgroundLaunchFailure = !result.launched && !dialogStillOpen;
      const detail = result.warning || (!result.launched ? result.resumeCommand : "");
      setStatus({ kind: backgroundLaunchFailure ? "error" : "success", message: detail ? `${summary}\n${detail}` : summary });
      if (dialogStillOpen) setDialog(result.launched ? null : { kind: "launch-failed", session, result });
      if (!backgroundLaunchFailure) {
        window.setTimeout(() => {
          setStatus((current) => (current?.kind === "success" && current.message.startsWith(summary) ? null : current));
        }, 2200);
      }
    } catch (error) {
      setStatus({ kind: "error", message: message(error) });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const clearProgress = useCallback(() => setProgress(null), []);

  return { dialog, progress, busy, begin, close, run, clearProgress };
}
