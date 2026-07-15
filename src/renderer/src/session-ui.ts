import type {
  MigrationAgent,
  MigrationTarget,
  ProjectSummary,
  SearchOptions,
  SessionSearchResult,
  SessionSource,
  SessionSourceStats,
  SessionStatsPeriod,
  SessionStatsSummary,
} from "../../core/types";
import { migrationAgentForSource, supportedMigrationTargets } from "../../core/session-migration";
import { enabledMigrationTargets, migrationTargetDescriptor, type MigrationTargetSettings } from "../../core/migration-targets";
import type { AppSettings } from "../../core/platform";
import type { ResumeRouteResult } from "../../core/resume-router";
import { localize, type LanguageMode } from "./language";
import { liveStateLabel, type LiveSessionState, type LiveStatusFilter } from "./live-filter";
import { isLocalSessionEnvironment } from "../../core/session-environment";

export const SOURCE_LABEL: Record<SessionSource, string> = {
  "claude-cli": "Claude Code",
  "claude-app": "Claude Code",
  "claude-internal": "Claude Code Internal",
  "codex-cli": "Codex",
  "codex-app": "Codex",
  "codex-internal": "Codex Internal",
  "tclaude-cli": "TClaude",
  "tcodex-cli": "TCodex",
  "codebuddy-cli": "CodeBuddy CLI",
  "codewiz-cli": "CodeWiz",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  "opencode-cli": "OpenCode",
  "cursor-agent": "Cursor Agent",
  trae: "Trae",
};

export interface UsageStatsDisplayRow extends SessionStatsSummary {
  key: string;
  label: string;
}

function usageStatsDisplayGroup(source: SessionSource): { key: string; label: string } {
  if (source === "codex-cli" || source === "codex-app") return { key: "codex", label: "Codex" };
  if (source === "claude-cli" || source === "claude-app") return { key: "claude", label: "Claude Code" };
  return { key: source, label: SOURCE_LABEL[source] };
}

export function usageStatsDisplayRows(rows: SessionSourceStats[]): UsageStatsDisplayRow[] {
  const grouped = new Map<string, UsageStatsDisplayRow>();
  for (const row of rows) {
    const group = usageStatsDisplayGroup(row.source);
    const current = grouped.get(group.key) ?? {
      ...group,
      sessionCount: 0,
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
    current.sessionCount += row.sessionCount;
    current.messageCount += row.messageCount;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cachedInputTokens += row.cachedInputTokens;
    current.reasoningOutputTokens += row.reasoningOutputTokens;
    current.totalTokens += row.totalTokens;
    grouped.set(group.key, current);
  }
  return [...grouped.values()];
}

const BASE_SOURCE_FILTERS: Array<{ label: string; value: SearchOptions["source"] }> = [
  { label: "All", value: "all" },
  { label: "Claude Code", value: "claude" },
  { label: "Codex", value: "codex" },
];

export function sourceFilters(settings: AppSettings | null): Array<{ label: string; value: SearchOptions["source"] }> {
  return [
    ...BASE_SOURCE_FILTERS,
    ...(settings?.includeClaudeInternal ? [{ label: migrationTargetDescriptor("claude-internal").label, value: "claude-internal" as const }] : []),
    ...(settings?.includeCodexInternal ? [{ label: migrationTargetDescriptor("codex-internal").label, value: "codex-internal" as const }] : []),
    ...(settings?.includeTclaude ? [{ label: "TClaude", value: "tclaude-cli" as const }] : []),
    ...(settings?.includeTcodex ? [{ label: "TCodex", value: "tcodex-cli" as const }] : []),
    ...(settings?.includeCodeBuddyCli ? [{ label: "CodeBuddy CLI", value: "codebuddy-cli" as const }] : []),
    ...(settings?.includeCodeWizCli ? [{ label: "CodeWiz", value: "codewiz-cli" as const }] : []),
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

export function displayTagName(tagName: string): string {
  return tagName.startsWith("branch:") ? tagName.slice("branch:".length) : tagName;
}

export function sourceUiFamily(source: SessionSource): "claude" | "codex" | "codebuddy" | "codewiz" | "other" {
  if (source.startsWith("claude")) return "claude";
  if (source.startsWith("codex")) return "codex";
  if (source === "codebuddy-cli") return "codebuddy";
  if (source === "codewiz-cli") return "codewiz";
  return "other";
}

export function supportsResumeSource(source: SessionSource): boolean {
  return source.startsWith("claude") || source.startsWith("codex") || source === "codebuddy-cli" || source === "codewiz-cli";
}

export function supportsMigrationSource(source: SessionSource): boolean {
  return supportedMigrationTargets(source).length > 0;
}

export function migrationTargetsForSource(source: SessionSource, settings: MigrationTargetSettings): MigrationTarget[] {
  return supportedMigrationTargets(source, enabledMigrationTargets(settings));
}

export function migrationTargetsForSession(
  session: Pick<SessionSearchResult, "source" | "environmentId" | "environmentKind">,
  settings: MigrationTargetSettings,
): MigrationTarget[] {
  return isLocalSessionEnvironment(session) ? migrationTargetsForSource(session.source, settings) : [];
}

export function migrationAgentLabel(target: MigrationTarget): string {
  return migrationTargetDescriptor(target).label;
}

export function sourceMigrationAgent(source: SessionSource): MigrationAgent | null {
  return migrationAgentForSource(source);
}

export function sessionSortTimestamp(
  session: Pick<SessionSearchResult, "timestamp" | "fileMtimeMs" | "lastActivityAt">,
): number {
  return session.lastActivityAt || session.fileMtimeMs || session.timestamp || 0;
}

export function projectSortTimestamp(project: Pick<ProjectSummary, "createdAt" | "lastActivityAt">): number {
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
  return !isLocalSessionEnvironment(session);
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

export function remoteMigrationTitle(language: LanguageMode): string {
  return localize(language, "Remote session migration is not supported yet.", "首版仅支持本地会话迁移。");
}

export function unsupportedMigrationTitle(language: LanguageMode): string {
  return localize(language, "This source cannot be migrated yet.", "暂不支持迁移这个来源。");
}
