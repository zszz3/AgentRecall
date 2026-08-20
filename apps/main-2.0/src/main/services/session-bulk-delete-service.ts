import type { SessionStore } from "../../core/session-store";
import {
  SESSION_BULK_DELETE_CONFIRMATION_THRESHOLD,
  SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
  SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE,
  type SessionDeleteOptions,
  type SessionBulkDeleteIssue,
  type SessionBulkDeletePreview,
  type SessionBulkDeleteRequest,
  type SessionBulkDeleteResult,
  type SessionBulkDeleteTarget,
} from "../../core/session-bulk-delete";
import { deleteDeepSeekCliSessionDirectory } from "../../core/deepseek-harness";
import { deleteLocalSessionSources } from "../../core/session-source-delete";
import { sessionSourceDescriptor } from "../../core/session-sources";
import type { SessionEnvironment, SessionSource } from "../../core/types";
import { deleteWslSessionSources } from "../../core/wsl-session-actions";
import { deleteZcodeSessions } from "../../core/zcode-session-writer";

const SHARED_DATABASE_SOURCES = new Set<SessionSource>(["hermes", "opencode-cli", "codewiz-cli"]);
const WSL_FILE_SOURCES = new Set<SessionSource>(["codex-cli", "codex-app", "claude-cli", "claude-app"]);

interface SessionBulkDeleteOptions extends SessionDeleteOptions {
  requireSingleSession?: boolean;
}

interface SessionDeletePreflight {
  preview: SessionBulkDeletePreview;
  allRows: SessionBulkDeleteTarget[];
  targets: SessionBulkDeleteTarget[];
}

export class SessionBulkDeleteService {
  constructor(private readonly store: SessionStore) {}

  async preview(request: SessionBulkDeleteRequest): Promise<SessionBulkDeletePreview> {
    return (await this.preflight(request)).preview;
  }

  async delete(
    request: SessionBulkDeleteRequest,
    options: SessionBulkDeleteOptions = {},
  ): Promise<SessionBulkDeleteResult> {
    const { preview, targets } = options.requireSingleSession
      ? await this.prepareSingleDelete(request, options)
      : await this.preflight(request, options);
    const confirmed = options.requireSingleSession ? options.confirmed === true : request.confirmed === true;
    if (!options.requireSingleSession && confirmed && request.confirmationFingerprint !== preview.confirmationFingerprint) {
      throw new Error(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
    }
    if (
      !options.requireSingleSession
      && preview.liveSessionCheckFailed
      && !(request.confirmed === true && request.allowUnverifiedLiveSessions === true)
    ) {
      throw new Error(SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE);
    }
    if (
      !options.requireSingleSession
      && request.confirmed !== true
      && requiresBulkDeleteConfirmation(preview)
    ) {
      throw new Error(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
    }
    if (targets.length === 0) return { ...preview, deletedSessionKeys: [], failed: [] };
    const failed: SessionBulkDeleteIssue[] = [];
    const successfulKeys = new Set<string>();
    const environments = new Map((await this.store.listEnvironments()).map((environment) => [environment.id, environment]));

    for (const family of groupBy(targets, (target) => target.cascadeRootSessionKey).values()) {
      try {
        await deleteTargetFamily(family, environments);
        for (const target of family) successfulKeys.add(target.sessionKey);
      } catch (error) {
        addGroupFailure(family, error, failed);
      }
    }

    const successfulSessionKeys = targets
      .map((target) => target.sessionKey)
      .filter((sessionKey) => successfulKeys.has(sessionKey));
    if (successfulSessionKeys.length === 0) return { ...preview, deletedSessionKeys: [], failed };
    await this.store.invalidateOpenVikingEvidenceForSessions(
      targets.filter((target) => successfulKeys.has(target.sessionKey)),
    );
    const deletedSessionKeys = await this.store.deleteSessionRecords(successfulSessionKeys, false);
    return { ...preview, deletedSessionKeys, failed };
  }

  async prepareSingleDelete(
    request: SessionBulkDeleteRequest,
    options: SessionDeleteOptions = {},
  ): Promise<SessionDeletePreflight> {
    const prepared = await this.preflight(request, options);
    const confirmed = options.confirmed === true;
    const allowLiveSessions = confirmed && options.allowLiveSessions === true;
    const allowUnverifiedLiveSessions = confirmed && options.allowUnverifiedLiveSessions === true;
    const hasLiveSession = prepared.preview.skipped.some((issue) => issue.reason === "live");
    if (
      confirmed
      && options.confirmationFingerprint !== undefined
      && options.confirmationFingerprint !== prepared.preview.confirmationFingerprint
    ) {
      throw new Error(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
    }
    if (prepared.preview.liveSessionCheckFailed && !allowUnverifiedLiveSessions) {
      throw new Error(SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE);
    }
    if (
      (!confirmed && (prepared.allRows.length > 1 || prepared.preview.includesOpenSession))
      || (hasLiveSession && !allowLiveSessions)
    ) {
      throw new Error(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
    }
    return prepared;
  }

  private async preflight(
    request: SessionBulkDeleteRequest,
    options: SessionDeleteOptions = {},
  ): Promise<SessionDeletePreflight> {
    const { sessionKeys, openSessionKey } = normalizeRequest(request);
    const rows = await this.store.getSessionDeletionTargets(sessionKeys, request.includeOrphanedSubagents === true);
    return buildPreflight(request, sessionKeys, openSessionKey, rows, options);
  }
}

function normalizeRequest(request: SessionBulkDeleteRequest): {
  sessionKeys: string[];
  openSessionKey: string | null;
} {
  if (!request || !Array.isArray(request.sessionKeys) || !Array.isArray(request.liveSessionKeys)) {
    throw new Error("The bulk deletion request is invalid.");
  }
  if (
    request.sessionKeys.some((key) => typeof key !== "string")
    || request.liveSessionKeys.some((key) => typeof key !== "string")
  ) {
    throw new Error("The bulk deletion request is invalid.");
  }
  if (request.protectFavorites !== undefined && typeof request.protectFavorites !== "boolean") {
    throw new Error("The bulk deletion request is invalid.");
  }
  if (request.includeOrphanedSubagents !== undefined && typeof request.includeOrphanedSubagents !== "boolean") {
    throw new Error("The orphan cleanup option is invalid.");
  }
  if (request.confirmed !== undefined && typeof request.confirmed !== "boolean") {
    throw new Error("The bulk deletion request is invalid.");
  }
  if (
    request.openSessionKey !== undefined
    && (typeof request.openSessionKey !== "string" || request.openSessionKey.trim().length === 0)
  ) {
    throw new Error("The bulk deletion request is invalid.");
  }
  if (
    (request.liveSessionCheckFailed !== undefined && typeof request.liveSessionCheckFailed !== "boolean")
    || (
      request.allowUnverifiedLiveSessions !== undefined
      && typeof request.allowUnverifiedLiveSessions !== "boolean"
    )
    || (request.confirmationFingerprint !== undefined && typeof request.confirmationFingerprint !== "string")
  ) {
    throw new Error("The bulk deletion request is invalid.");
  }
  const keys = [...new Set(request.sessionKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length > 100_000) throw new Error("Too many sessions were selected.");
  if (request.inactiveBefore !== undefined && (!Number.isFinite(request.inactiveBefore) || request.inactiveBefore <= 0)) {
    throw new Error("The inactivity cutoff is invalid.");
  }
  return {
    sessionKeys: keys,
    openSessionKey: request.openSessionKey?.trim() ?? null,
  };
}

function buildPreflight(
  request: SessionBulkDeleteRequest,
  sessionKeys: string[],
  openSessionKey: string | null,
  rows: SessionBulkDeleteTarget[],
  options: SessionDeleteOptions,
): SessionDeletePreflight {
  const liveKeys = new Set(request.liveSessionKeys);
  const families = groupBy(rows, (row) => row.cascadeRootSessionKey);
  const skipped: SessionBulkDeleteIssue[] = [];
  const candidateFamilies: SessionBulkDeleteTarget[][] = [];
  const blockedSessionKeys = new Set<string>();
  const rootKeys = [...sessionKeys];
  const rootKeySet = new Set(rootKeys);
  if (request.includeOrphanedSubagents) {
    for (const rootKey of families.keys()) {
      if (rootKeySet.has(rootKey)) continue;
      rootKeySet.add(rootKey);
      rootKeys.push(rootKey);
    }
  }
  let matchedCount = 0;
  for (const rootKey of rootKeys) {
    const family = families.get(rootKey);
    if (!family) {
      skipped.push(issueFor(rootKey, "not-found", "Session was not found."));
      continue;
    }
    matchedCount += 1;
    const issues = family.flatMap((target) => {
      const issue = classifyTarget(target, request, liveKeys, options);
      return issue ? [issue] : [];
    });
    if (issues.length > 0) {
      skipped.push(...issues);
      for (const target of family) blockedSessionKeys.add(target.sessionKey);
    } else {
      candidateFamilies.push(family);
    }
  }
  const acceptedFamilies = candidateFamilies.filter(
    (family) => !family.some((target) => blockedSessionKeys.has(target.sessionKey)),
  );
  const targets = dedupeAcceptedFamilies(acceptedFamilies);
  const allRows = dedupeTargets(rows);
  const expandedCount = allRows.length;
  const sourceCounts = [...countSources(targets).entries()].map(([source, count]) => ({ source, count }));
  return {
    allRows,
    targets,
    preview: {
      requestedCount: rootKeys.length,
      matchedCount,
      expandedCount,
      deletableCount: targets.length,
      hasRelatedSessions: hasRelatedTargets(targets),
      includesOpenSession: openSessionKey !== null
        && targets.some((target) => target.sessionKey === openSessionKey),
      liveSessionCheckFailed: request.liveSessionCheckFailed === true,
      confirmationFingerprint: deletionConfirmationFingerprint(allRows, request, openSessionKey),
      sourceCounts,
      skipped: dedupeIssues(skipped),
    },
  };
}

function deletionConfirmationFingerprint(
  rows: SessionBulkDeleteTarget[],
  request: SessionBulkDeleteRequest,
  openSessionKey: string | null,
): string {
  return JSON.stringify({
    targets: rows.map((row) => row.sessionKey).sort(),
    live: [...new Set(request.liveSessionKeys)].sort(),
    liveSessionCheckFailed: request.liveSessionCheckFailed === true,
    openSessionKey,
  });
}

function requiresBulkDeleteConfirmation(preview: SessionBulkDeletePreview): boolean {
  return preview.deletableCount >= SESSION_BULK_DELETE_CONFIRMATION_THRESHOLD
    || preview.hasRelatedSessions
    || preview.includesOpenSession;
}

function classifyTarget(
  target: SessionBulkDeleteTarget,
  request: SessionBulkDeleteRequest,
  liveKeys: Set<string>,
  options: SessionDeleteOptions,
): SessionBulkDeleteIssue | null {
  const liveFamily = sessionSourceDescriptor(target.source).liveFamily;
  const familyKey = liveFamily === null ? null : `${liveFamily}:${target.rawId}`;
  const scopedFamilyKey = familyKey === null ? null : `${target.environmentId}\0${familyKey}`;
  const ancestorIsLive = liveFamily !== null && target.ancestorRawIds.some((rawId) =>
    liveKeys.has(`${liveFamily}:${rawId}`)
    || liveKeys.has(`${target.environmentId}\0${liveFamily}:${rawId}`));
  if (
    liveKeys.has(target.sessionKey)
    || (familyKey !== null && liveKeys.has(familyKey))
    || (scopedFamilyKey !== null && liveKeys.has(scopedFamilyKey))
    || ancestorIsLive
  ) {
    const allowLiveSessions = options.confirmed === true && options.allowLiveSessions === true;
    if (!allowLiveSessions) return issueFor(target.sessionKey, "live", "Live sessions cannot be deleted.");
  }
  if ((request.protectFavorites || request.inactiveBefore !== undefined) && target.favorited) {
    return issueFor(target.sessionKey, "favorite", "Favorite session was protected.");
  }
  if (request.inactiveBefore !== undefined && target.lastActivityAt >= request.inactiveBefore) {
    return issueFor(target.sessionKey, "recent", "Session is not older than the selected cutoff.");
  }
  if (target.source === "pi-cli" || target.source === "workbuddy-cli" || target.source === "kimi-cli") {
    const label = target.source === "pi-cli" ? "Pi" : target.source === "workbuddy-cli" ? "WorkBuddy" : "Kimi Code";
    return issueFor(target.sessionKey, "read-only", `${label} session source files are read-only.`);
  }
  if (SHARED_DATABASE_SOURCES.has(target.source)) return issueFor(target.sessionKey, "shared-database", "This source stores multiple sessions in a shared database.");
  if (target.source === "cursor-agent" && /(^|[\\/])state\.vscdb$/iu.test(target.filePath) && target.sourceAvailable) {
    return issueFor(target.sessionKey, "shared-database", "This Cursor session is stored in a shared database.");
  }
  if (target.environmentKind === "ssh") return issueFor(target.sessionKey, "remote-source", "SSH session source files cannot be deleted here.");
  if (target.environmentKind === "wsl" && !WSL_FILE_SOURCES.has(target.source)) {
    return issueFor(target.sessionKey, "remote-source", "This WSL session source is not supported for deletion.");
  }
  return null;
}

function issueFor(sessionKey: string, reason: SessionBulkDeleteIssue["reason"], message: string): SessionBulkDeleteIssue {
  return { sessionKey, reason, message };
}

function countSources(targets: SessionBulkDeleteTarget[]): Map<SessionSource, number> {
  const counts = new Map<SessionSource, number>();
  for (const target of targets) counts.set(target.source, (counts.get(target.source) ?? 0) + 1);
  return counts;
}

async function deleteTargetFamily(
  targets: SessionBulkDeleteTarget[],
  environments: Map<string, SessionEnvironment>,
): Promise<void> {
  const cascadeRoot = targets.find((target) => target.sessionKey === target.cascadeRootSessionKey);
  if (!cascadeRoot) throw new Error("Session deletion family is missing its cascade root.");
  const staleCodexAppTargets = targets.filter((target) =>
    target.source === "codex-app"
    && !target.sourceAvailable
    && target.environmentKind === "local",
  );
  if (staleCodexAppTargets.length > 0) deleteLocalSessionSources(staleCodexAppTargets);
  if (!cascadeRoot.sourceAvailable && !cascadeRoot.orphanedParentSessionId) return;
  const availableTargets = targets.filter((target) => target.sourceAvailable);
  if (availableTargets.length === 0) return;
  if (availableTargets[0].source === "zcode-cli") {
    for (const group of groupBy(availableTargets, (target) => target.filePath).values()) {
      deleteZcodeSessions(group[0].filePath, group.map((target) => target.rawId));
    }
    return;
  }
  if (availableTargets[0].source === "deepseek-cli") {
    for (const target of availableTargets) deleteDeepSeekCliSessionDirectory(target.filePath);
    return;
  }
  if (availableTargets[0].environmentKind === "wsl") {
    const environment = environments.get(availableTargets[0].environmentId);
    if (!environment) throw new Error("WSL environment was not found.");
    if (!environment.enabled) throw new Error("WSL environment is disabled.");
    await deleteWslSessionSources(environment, availableTargets);
    return;
  }
  deleteLocalSessionSources(availableTargets);
}

function dedupeAcceptedFamilies(families: SessionBulkDeleteTarget[][]): SessionBulkDeleteTarget[] {
  const result: SessionBulkDeleteTarget[] = [];
  const seen = new Set<string>();
  for (const family of [...families].sort((left, right) => right.length - left.length)) {
    for (const target of family) {
      if (seen.has(target.sessionKey)) continue;
      seen.add(target.sessionKey);
      result.push(target);
    }
  }
  return result;
}

function dedupeTargets(targets: SessionBulkDeleteTarget[]): SessionBulkDeleteTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.sessionKey)) return false;
    seen.add(target.sessionKey);
    return true;
  });
}

function hasRelatedTargets(targets: SessionBulkDeleteTarget[]): boolean {
  return [...groupBy(targets, (target) => target.cascadeRootSessionKey).values()]
    .some((family) => new Set(family.map((target) => target.sessionKey)).size > 1);
}

function dedupeIssues(issues: SessionBulkDeleteIssue[]): SessionBulkDeleteIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.sessionKey}\0${issue.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addGroupFailure(group: SessionBulkDeleteTarget[], error: unknown, failed: SessionBulkDeleteIssue[]): void {
  const message = error instanceof Error ? error.message : String(error);
  for (const target of group) failed.push(issueFor(target.sessionKey, "delete-failed", message));
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}
