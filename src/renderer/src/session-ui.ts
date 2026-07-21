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
import { supportedMigrationTargets } from "../../core/session-migration";
import { enabledMigrationTargets, migrationTargetDescriptor, type MigrationTargetSettings } from "../../core/migration-targets";
import {
  OPTIONAL_SESSION_SOURCE_DESCRIPTORS,
  SESSION_SOURCE_DESCRIPTORS,
  sessionSourceDescriptor,
  type SessionSourceUiFamily,
} from "../../core/session-sources";
import type { AppSettings } from "../../core/platform";
import type { ResumeRouteResult } from "../../core/resume-router";
import { localize, type LanguageMode } from "./language";
import { liveStateLabel, type LiveSessionState, type LiveStatusFilter } from "./live-filter";
import { isLocalSessionEnvironment } from "../../core/session-environment";

export const SOURCE_LABEL = Object.fromEntries(
  SESSION_SOURCE_DESCRIPTORS.map(({ id, label }) => [id, label]),
) as Record<SessionSource, string>;

export interface UsageStatsDisplayRow extends SessionStatsSummary {
  key: string;
  label: string;
}

function usageStatsDisplayGroup(source: SessionSource): { key: string; label: string } {
  const descriptor = sessionSourceDescriptor(source);
  if (descriptor.statsGroup) {
    return { key: descriptor.statsGroup, label: descriptor.statsGroup === "claude" ? "Claude Code" : "Codex" };
  }
  return { key: source, label: descriptor.label };
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

export function hasTokenUsage(value: Pick<SessionStatsSummary, "totalTokens">): boolean {
  return value.totalTokens > 0;
}

const BASE_SOURCE_FILTERS: Array<{ label: string; value: SearchOptions["source"] }> = [
  { label: "All", value: "all" },
  { label: "Claude Code", value: "claude" },
  { label: "Codex", value: "codex" },
];

export function sourceFilters(settings: AppSettings | null): Array<{ label: string; value: SearchOptions["source"] }> {
  return [
    ...BASE_SOURCE_FILTERS,
    ...OPTIONAL_SESSION_SOURCE_DESCRIPTORS.flatMap((descriptor) =>
      settings?.[descriptor.optionalSetting] ? [{ label: descriptor.label, value: descriptor.id }] : []),
  ];
}

export function isBranchTag(tagName: string): boolean {
  return tagName.startsWith("branch:");
}

export function displayTagName(tagName: string): string {
  return tagName.startsWith("branch:") ? tagName.slice("branch:".length) : tagName;
}

export function sourceUiFamily(source: SessionSource): SessionSourceUiFamily {
  return sessionSourceDescriptor(source).uiFamily;
}

export function supportsResumeSource(source: SessionSource): boolean {
  return sessionSourceDescriptor(source).capabilities.resume;
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
  return sessionSourceDescriptor(source).migrationAgent;
}

export function sessionSortTimestamp(
  session: Pick<SessionSearchResult, "timestamp" | "fileMtimeMs" | "lastActivityAt">,
): number {
  return session.lastActivityAt || session.fileMtimeMs || session.timestamp || 0;
}

export function projectSortTimestamp(project: Pick<ProjectSummary, "createdAt" | "lastActivityAt">): number {
  return project.lastActivityAt || project.createdAt || 0;
}

export function projectDisplayLabel(
  project: Pick<ProjectSummary, "label" | "labelKind" | "labelSuffix">,
  language: LanguageMode,
): string {
  const base = project.labelKind === "codex-task-untitled"
    ? localize(language, "Untitled session", "未命名会话")
    : project.label;
  return project.labelSuffix ? `${base} · ${project.labelSuffix}` : base;
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
  if (result.route === "app") return localize(language, "Codex task opened.", "已打开 Codex 会话。");
  return result.route === "focus"
    ? localize(language, "Terminal brought to front.", "终端已前置。")
    : localize(language, "Resume command sent to terminal.", "Resume 命令已发送到终端。");
}

export function resumeActionLabel(source: SessionSource, language: LanguageMode): string {
  return source === "codex-app"
    ? localize(language, "Opening in Codex", "正在 Codex 中打开")
    : localize(language, "Opening terminal", "正在打开终端");
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
