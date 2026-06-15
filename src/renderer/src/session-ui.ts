import type { ProjectSummary, SearchOptions, SessionSearchResult, SessionSortBy, SessionSource, SessionStatsPeriod } from "../../core/types";
import type { AppSettings } from "../../core/platform";
import type { ResumeRouteResult } from "../../core/resume-router";
import { localize, type LanguageMode } from "./language";
import { liveStateLabel, type LiveSessionState, type LiveStatusFilter } from "./live-filter";

export const SOURCE_LABEL: Record<SessionSource, string> = {
  "claude-cli": "Claude Code",
  "claude-app": "Claude Code",
  "claude-internal": "Claude Extra",
  "codex-cli": "Codex",
  "codex-app": "Codex",
  "codex-internal": "Codex Extra",
  "codebuddy-cli": "CodeBuddy CLI",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  "opencode-cli": "OpenCode",
  "cursor-agent": "Cursor Agent",
  trae: "Trae",
};

const BASE_SOURCE_FILTERS: Array<{ label: string; value: SearchOptions["source"] }> = [
  { label: "All", value: "all" },
  { label: "Claude Code", value: "claude" },
  { label: "Codex", value: "codex" },
];

export function sourceFilters(settings: AppSettings | null): Array<{ label: string; value: SearchOptions["source"] }> {
  return [
    ...BASE_SOURCE_FILTERS,
    ...(settings?.includeClaudeInternal ? [{ label: "Claude Extra", value: "claude-internal" as const }] : []),
    ...(settings?.includeCodexInternal ? [{ label: "Codex Extra", value: "codex-internal" as const }] : []),
    ...(settings?.includeCodeBuddyCli ? [{ label: "CodeBuddy CLI", value: "codebuddy-cli" as const }] : []),
    ...(settings?.includeOpenClaw ? [{ label: "OpenClaw", value: "openclaw" as const }] : []),
    ...(settings?.includeHermes ? [{ label: "Hermes", value: "hermes" as const }] : []),
    ...(settings?.includeOpenCode ? [{ label: "OpenCode", value: "opencode-cli" as const }] : []),
    ...(settings?.includeCursorAgent ? [{ label: "Cursor Agent", value: "cursor-agent" as const }] : []),
    ...(settings?.includeTrae ? [{ label: "Trae", value: "trae" as const }] : []),
  ];
}

export function isBranchTag(tagName: string): boolean {
  return tagName.startsWith("branch:");
}

export function sourceUiFamily(source: SessionSource): "claude" | "codex" | "codebuddy" | "other" {
  if (source.startsWith("claude")) return "claude";
  if (source.startsWith("codex")) return "codex";
  if (source === "codebuddy-cli") return "codebuddy";
  return "other";
}

export function supportsResumeSource(source: SessionSource): boolean {
  return source.startsWith("claude") || source.startsWith("codex") || source === "codebuddy-cli";
}

export function sessionSortOptions(): Array<{ label: string; value: SessionSortBy }> {
  return [
    { label: "Recent conversation", value: "activity" },
    { label: "Created", value: "created" },
  ];
}

export function sessionSortTimestamp(
  session: Pick<SessionSearchResult, "timestamp" | "fileMtimeMs" | "lastActivityAt">,
  sortBy: SessionSortBy,
): number {
  if (sortBy === "created") return session.timestamp || 0;
  return session.lastActivityAt || session.fileMtimeMs || session.timestamp || 0;
}

export function projectSortTimestamp(project: Pick<ProjectSummary, "createdAt" | "lastActivityAt">, sortBy: SessionSortBy): number {
  if (sortBy === "created") return project.createdAt || 0;
  return project.lastActivityAt || project.createdAt || 0;
}

export function statsPeriodLabel(value: SessionStatsPeriod, language: LanguageMode): string {
  if (value === "today") return localize(language, "Today", "今天");
  if (value === "sevenDay") return localize(language, "7D", "7 天");
  if (value === "thirtyDay") return localize(language, "30D", "30 天");
  return localize(language, "All", "全部");
}

export function liveStatusFilterLabel(value: LiveStatusFilter, language: LanguageMode): string {
  if (value === "open") return localize(language, "Open", "打开");
  if (value === "closed") return localize(language, "Closed", "关闭");
  return localize(language, "All", "全部");
}

export function sourceFilterLabel(item: { label: string; value: SearchOptions["source"] }, language: LanguageMode): string {
  return item.value === "all" ? localize(language, "All", "全部") : item.label;
}

export function localizedLiveStateLabel(state: LiveSessionState, language: LanguageMode): string {
  return localize(language, liveStateLabel(state), state === "open" ? "打开" : "关闭");
}

export function resumeRouteMessage(result: ResumeRouteResult, language: LanguageMode): string {
  return result.route === "focus"
    ? localize(language, "Terminal brought to front.", "终端已前置。")
    : localize(language, "Resume command sent to terminal.", "Resume 命令已发送到终端。");
}

export function isRemoteSession(session: Pick<SessionSearchResult, "environmentId" | "environmentKind">): boolean {
  return session.environmentKind === "ssh" && session.environmentId !== "local";
}

export function environmentBadgeLabel(
  session: Pick<SessionSearchResult, "environmentKind" | "environmentLabel">,
  language: LanguageMode,
): string {
  if (session.environmentKind === "ssh") return `SSH · ${session.environmentLabel}`;
  return localize(language, "Local", "本地");
}

export function environmentBadgeTitle(
  session: Pick<SessionSearchResult, "environmentKind" | "environmentLabel">,
  language: LanguageMode,
): string {
  if (session.environmentKind === "ssh") {
    return localize(language, `Remote SSH environment: ${session.environmentLabel}`, `远程 SSH 环境：${session.environmentLabel}`);
  }
  return localize(language, "Local session on this computer", "这台电脑上的本地会话");
}

export function remoteRevealTitle(language: LanguageMode): string {
  return localize(language, "remote paths cannot be revealed locally.", "远程路径不能在本机显示。");
}

export function remoteOpenAppTitle(language: LanguageMode): string {
  return localize(language, "remote sessions do not open local native apps.", "远程会话不能打开本机原生应用。");
}
