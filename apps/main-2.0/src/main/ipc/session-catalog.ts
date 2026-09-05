import type { IpcMain } from "electron";
import type { TraceEventQueryOptions } from "../../core/session-store";
import {
  SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
  type SessionBulkDeleteRequest,
  type SessionDeleteOptions,
} from "../../core/session-bulk-delete";
import type {
  ProjectQueryOptions,
  RuntimeInvocationLookup,
  SearchOptions,
  SessionStatsOptions,
  TagListOptions,
} from "../../core/types";
import { AGENT_RECALL_INVOCATION_SURFACES } from "../../shared/runtime-invocation";
import type { SessionCatalogService } from "../services/session-catalog-service";

/**
 * Adapts Electron's transport to the Session catalog interface. Session
 * hydration and visibility rules remain inside the service.
 */
export function registerSessionCatalogIpc(
  ipc: Pick<IpcMain, "handle">,
  service: SessionCatalogService,
): void {
  ipc.handle("search:sessions", (_event, options: SearchOptions) => service.search(options));
  ipc.handle("search:session-page", (_event, options: SearchOptions) => service.searchPage(options));
  ipc.handle("session:get", (_event, sessionKey: string) => service.get(sessionKey));
  ipc.handle("session:find-by-raw-id", (_event, rawId: string) => service.findByRawId(rawId));
  ipc.handle("session:resolve-runtime-owner", (_event, lookup: unknown) =>
    service.resolveRuntimeInvocationSession(runtimeInvocationLookup(lookup)));
  ipc.handle("session:turns", (_event, sessionKey: string) => service.listTurns(sessionKey));
  ipc.handle("session:turn", (_event, sessionKey: string, turnId: string) =>
    service.getTurn(sessionKey, turnId));
  ipc.handle(
    "session:messages",
    (_event, sessionKey: string, offset?: number, limit?: number) =>
      service.getMessages(sessionKey, offset, limit),
  );
  ipc.handle(
    "session:trace-events",
    (_event, sessionKey: string, options?: TraceEventQueryOptions) =>
      service.getTraceEvents(sessionKey, options),
  );
  ipc.handle("sessions:live", (_event, fresh = false) => service.getLiveSessions(fresh));
  ipc.handle("stats:get", (_event, options?: SessionStatsOptions) => service.getStats(options));
  ipc.handle("stats:trend", (_event, options?: SessionStatsOptions) => service.getStatsTrend(options));
  ipc.handle("tags:list", (_event, options?: TagListOptions) => service.listTags(options));
  ipc.handle("projects:list", (_event, options?: ProjectQueryOptions) => service.listProjects(options));
  ipc.handle("tags:by-project", () => service.listTagsByProject());
  ipc.handle("environments:list", () => service.listEnvironments());
  ipc.handle("title:set", (_event, sessionKey: string, title: string | null) =>
    service.setCustomTitle(sessionKey, title));
  ipc.handle("tag:add", (_event, sessionKey: string, tagName: string) =>
    service.addTag(sessionKey, tagName));
  ipc.handle("tag:remove", (_event, sessionKey: string, tagName: string) =>
    service.removeTag(sessionKey, tagName));
  ipc.handle("tag:delete", (_event, tagName: string) => service.deleteTag(tagName));
  ipc.handle("favorite:set", (_event, sessionKey: string, favorited: boolean) =>
    service.setFavorited(sessionKey, favorited));
  ipc.handle("hide:set", (_event, sessionKey: string, hidden: boolean) =>
    service.setHidden(sessionKey, hidden));
  ipc.handle("session:set-open", (_event, sessionKey?: string) => service.setOpenSession(sessionKey));
  ipc.handle("session:delete", (_event, sessionKey: string, options?: SessionDeleteOptions) => {
    if (options?.confirmed === true && !options.confirmationFingerprint) {
      throw new Error(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
    }
    return service.delete(sessionKey, options);
  });
  ipc.handle("session:bulk-delete-preview", (_event, request: SessionBulkDeleteRequest) =>
    service.previewBulkDelete(request));
  ipc.handle("session:bulk-delete", (_event, request: SessionBulkDeleteRequest) =>
    service.bulkDeleteSessions(request));
  ipc.handle("index:refresh", () => service.refreshIndex());
  ipc.handle("index:status", () => service.getIndexStatus());
}

function runtimeInvocationLookup(value: unknown): RuntimeInvocationLookup {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime invocation lookup must be an object.");
  }
  const record = value as Record<string, unknown>;
  const invocationId = optionalLookupString(record.invocationId, "invocationId");
  const role = optionalLookupString(record.role, "role");
  const surface = record.surface;
  if (
    surface !== undefined
    && (
      typeof surface !== "string"
      || !(AGENT_RECALL_INVOCATION_SURFACES as readonly string[]).includes(surface)
    )
  ) {
    throw new Error("Runtime invocation lookup contains an invalid surface.");
  }
  const ownerReference = record.ownerReference === undefined
    ? undefined
    : runtimeInvocationOwnerReference(record.ownerReference);
  if (!invocationId && !ownerReference) {
    throw new Error("Runtime invocation lookup requires invocationId or ownerReference.");
  }
  return {
    ...(invocationId ? { invocationId } : {}),
    ...(surface ? { surface: surface as RuntimeInvocationLookup["surface"] } : {}),
    ...(role ? { role } : {}),
    ...(ownerReference ? { ownerReference } : {}),
  };
}

function runtimeInvocationOwnerReference(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime invocation owner reference must be an object.");
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 32) {
    throw new Error("Runtime invocation owner reference must contain between 1 and 32 fields.");
  }
  for (const [key, nested] of entries) {
    if (!key || key.length > 80 || typeof nested !== "string" || !nested || nested.length > 1_000) {
      throw new Error("Runtime invocation owner reference contains an invalid field.");
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function optionalLookupString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 1_000) {
    throw new Error(`Runtime invocation lookup contains an invalid ${field}.`);
  }
  return value;
}
