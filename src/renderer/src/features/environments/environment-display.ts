import type { EnvironmentSyncState, SessionEnvironment } from "../../../../core/types";
import { localize, type LanguageMode } from "../../language";

export function environmentStatus(environment: SessionEnvironment): EnvironmentSyncState | "local" {
  if (environment.kind === "local") return "local";
  if (!environment.enabled) return "disconnected";
  return environment.syncState;
}

export function environmentStatusLabel(environment: SessionEnvironment, language: LanguageMode): string {
  const status = environmentStatus(environment);
  if (status === "local") return localize(language, "local", "本地");
  if (status === "syncing") return localize(language, "syncing", "同步中");
  if (status === "watching") return localize(language, "watching", "监听中");
  if (status === "error") return localize(language, "error", "错误");
  if (status === "disconnected") return localize(language, "disconnected", "未连接");
  return localize(language, "idle", "空闲");
}

export function environmentTarget(environment: SessionEnvironment, language: LanguageMode): string {
  if (environment.kind === "local") return localize(language, "This computer", "这台电脑");
  if (environment.kind === "wsl") return `${localize(language, "Windows Subsystem for Linux", "Windows Subsystem for Linux")} · ${localize(language, "Local Linux", "本地 Linux")}`;
  const destination = environment.hostAlias || environment.host || environment.label;
  const userPrefix = environment.user && !environment.hostAlias ? `${environment.user}@` : "";
  const portSuffix = environment.port ? `:${environment.port}` : "";
  return `${userPrefix}${destination}${portSuffix}`;
}
