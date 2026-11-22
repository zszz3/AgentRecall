import { useState, type Dispatch, type SetStateAction } from "react";
import type { SessionSearchApi } from "../../../../preload";
import type { RemoteHealthReport } from "../../../../core/remote-health";
import type { EnvironmentUpsertInput, SessionEnvironment } from "../../../../core/types";
import type { ActionStatus } from "../../app-types";
import { errorText, showTransientSuccess } from "../status/status-messages";

export interface EnvironmentActions {
  healthReports: Readonly<Record<string, RemoteHealthReport>>;
  diagnosingId: string | null;
  refresh(environment: SessionEnvironment): Promise<void>;
  diagnose(environment: SessionEnvironment): Promise<void>;
  remove(environment: SessionEnvironment): Promise<void>;
  /** Rejects after reporting the failure so the open dialog keeps the user's input. */
  save(input: EnvironmentUpsertInput): Promise<void>;
}

interface EnvironmentActionOptions {
  api: Pick<SessionSearchApi, "refreshEnvironment" | "diagnoseEnvironment" | "deleteEnvironment" | "saveEnvironment">;
  setStatus: Dispatch<SetStateAction<ActionStatus | null>>;
  /** Reloads the environment list and the Sessions that depend on it. */
  reload(): Promise<void>;
  onRemoved(environment: SessionEnvironment): void;
  t(en: string, zh: string): string;
}

export function useEnvironmentActions({ api, setStatus, reload, onRemoved, t }: EnvironmentActionOptions): EnvironmentActions {
  const [healthReports, setHealthReports] = useState<Record<string, RemoteHealthReport>>({});
  const [diagnosingId, setDiagnosingId] = useState<string | null>(null);

  async function refresh(environment: SessionEnvironment): Promise<void> {
    setStatus({ kind: "running", message: t(`Refreshing ${environment.label}...`, `正在刷新 ${environment.label}...`) });
    try {
      await api.refreshEnvironment(environment.id);
      await reload();
      showTransientSuccess(setStatus, t(`${environment.label} refreshed.`, `${environment.label} 已刷新。`));
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
    }
  }

  async function diagnose(environment: SessionEnvironment): Promise<void> {
    if (environment.kind !== "ssh" && environment.kind !== "wsl") return;
    setDiagnosingId(environment.id);
    setStatus({ kind: "running", message: t(`Checking ${environment.label}...`, `正在检查 ${environment.label}...`) });
    try {
      const report = await api.diagnoseEnvironment(environment.id);
      setHealthReports((current) => ({ ...current, [environment.id]: report }));
      setStatus({ kind: report.ok ? "success" : "error", message: report.summary });
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
    } finally {
      setDiagnosingId((current) => (current === environment.id ? null : current));
    }
  }

  async function remove(environment: SessionEnvironment): Promise<void> {
    setStatus({ kind: "running", message: t(`Deleting ${environment.label}...`, `正在删除 ${environment.label}...`) });
    try {
      await api.deleteEnvironment(environment.id);
      setHealthReports((current) => {
        const next = { ...current };
        delete next[environment.id];
        return next;
      });
      onRemoved(environment);
      await reload();
      showTransientSuccess(setStatus, t(`${environment.label} deleted.`, `${environment.label} 已删除。`));
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
    }
  }

  async function save(input: EnvironmentUpsertInput): Promise<void> {
    const wsl = input.kind === "wsl";
    setStatus({ kind: "running", message: wsl ? t("Saving WSL environment...", "正在保存 WSL 环境...") : t("Saving SSH environment...", "正在保存 SSH 环境...") });
    try {
      await api.saveEnvironment(input);
      await reload();
      showTransientSuccess(setStatus, wsl ? t("WSL environment saved.", "WSL 环境已保存。") : t("SSH environment saved.", "SSH 环境已保存。"));
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
      throw error;
    }
  }

  return { healthReports, diagnosingId, refresh, diagnose, remove, save };
}
