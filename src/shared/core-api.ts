import type { IndexStatus } from "../core/indexer";
import type { ResumeRouteResult } from "../core/resume-router";
import type { TraceEventQueryOptions } from "../core/session-store";
import type { GlobalShortcut } from "../core/shortcuts";
import type { TerminalChoice } from "../core/terminal-options";
import type { NativeUpdateState } from "../distribution/native-update-types";
import type {
  LegacyCleanupResult,
  LegacyIntegrationInspection,
} from "../privacy/legacy-integrations";
import type { PrivacyDiagnosticReport } from "../privacy/diagnostics";
import type {
  LiveSession,
  LiveSessionSnapshot,
  ProjectSummary,
  ProjectTagEntry,
  SessionEnvironment,
  SessionMessage,
  SessionSearchResult,
  SessionTraceEvent,
} from "../core/types";
import type {
  CoreSessionSource,
  ProductProfile,
} from "./product-profile";

export type CoreSessionFamily = "claude" | "codex";
export type CoreSessionSourceFilter =
  | CoreSessionSource
  | CoreSessionFamily
  | "all";
export type CoreLiveSessionKey = `${CoreSessionFamily}:${string}`;

/**
 * Renderer-controlled search input. Product source scoping is deliberately
 * absent: the main process owns and injects that restriction.
 */
export interface CoreSearchOptions {
  query?: string;
  tag?: string;
  projectPath?: string;
  environmentId?: "all" | "local";
  source?: CoreSessionSourceFilter;
  liveStatus?: "open" | "closed";
  liveSessionKeys?: CoreLiveSessionKey[];
  visibility?: "default" | "favorites";
  sortBy?: "activity" | "created";
  dateFrom?: number;
  dateTo?: number;
  limit?: number;
  excludeSubagents?: boolean;
}

export interface CoreProjectQueryOptions {
  excludeSubagents?: boolean;
  environmentId?: "all" | "local";
}

export interface CoreTagListOptions {
  environmentId?: "all" | "local";
  projectPath?: string;
  projectEnvironmentId?: "local";
  excludeSubagents?: boolean;
}

export type CoreTraceEventQueryOptions = TraceEventQueryOptions;

export type CoreSessionSearchResult = Omit<
  SessionSearchResult,
  "source" | "environmentId" | "environmentKind"
> & {
  source: CoreSessionSource;
  environmentId: "local";
  environmentKind: "local";
};

export interface CoreSessionSearchPage {
  sessions: CoreSessionSearchResult[];
  totalCount: number;
  hasMore: boolean;
}

export type CoreProjectSummary = Omit<ProjectSummary, "environmentId"> & {
  environmentId: "local";
};

export type CoreProjectTagEntry = Omit<ProjectTagEntry, "environmentId"> & {
  environmentId: "local";
};

/**
 * listEnvironments remains in Core for the existing project filter tree, but
 * the contract describes only the immutable local environment. SSH lifecycle
 * operations are intentionally absent from CoreApi.
 */
export type CoreSessionEnvironment = Omit<
  SessionEnvironment,
  | "id"
  | "kind"
  | "hostAlias"
  | "host"
  | "user"
  | "port"
  | "authMode"
  | "identityFile"
> & {
  id: "local";
  kind: "local";
  hostAlias: null;
  host: null;
  user: null;
  port: null;
  authMode: "none";
  identityFile: null;
};

export type CoreSessionTraceEvent = Omit<SessionTraceEvent, "source"> & {
  source: CoreSessionFamily;
};

export interface CoreLegacyCleanupPreview {
  planId: string;
  createdAt: string;
  backupLocation: string;
  requiresConfirmation: true;
  actions: Array<{
    filePath: string;
    description: string;
    findingCount: number;
  }>;
  issues: LegacyIntegrationInspection["issues"];
}

export type CoreLegacyCleanupResult = Pick<
  LegacyCleanupResult,
  "planId" | "backupDirectory" | "changedFiles" | "removedFindingIds"
>;

export type CoreLegacyIntegrationInspection = Pick<
  LegacyIntegrationInspection,
  "findings" | "issues"
>;

export type CoreLiveSession = Omit<LiveSession, "family"> & {
  family: CoreSessionFamily;
};

export type CoreLiveSessionSnapshot = Omit<
  LiveSessionSnapshot,
  "sessions"
> & {
  sessions: CoreLiveSession[];
};

export interface CoreSettings {
  defaultTerminal: TerminalChoice;
  globalShortcut: GlobalShortcut;
  claudeBinary: string;
  codexBinary: string;
  hideSubagentSessions: boolean;
  autoCheckUpdates: boolean;
}

export type CoreSettingsUpdate = Partial<CoreSettings>;

export interface CoreApi {
  readonly productProfile: ProductProfile;
  readonly platform: NodeJS.Platform;
  searchSessionPage(options: CoreSearchOptions): Promise<CoreSessionSearchPage>;
  getSession(sessionKey: string): Promise<CoreSessionSearchResult | null>;
  getMessages(sessionKey: string, offset?: number, limit?: number): Promise<SessionMessage[]>;
  getTraceEvents(sessionKey: string, options?: CoreTraceEventQueryOptions): Promise<CoreSessionTraceEvent[]>;
  getLiveSessions(): Promise<CoreLiveSessionSnapshot>;
  listTags(options?: CoreTagListOptions): Promise<string[]>;
  listProjects(options?: CoreProjectQueryOptions): Promise<CoreProjectSummary[]>;
  listTagsByProject(): Promise<CoreProjectTagEntry[]>;
  listEnvironments(): Promise<CoreSessionEnvironment[]>;
  setCustomTitle(sessionKey: string, title: string | null): Promise<void>;
  setFavorited(sessionKey: string, favorited: boolean): Promise<void>;
  refreshIndex(): Promise<IndexStatus>;
  getIndexStatus(): Promise<IndexStatus>;
  getSettings(): Promise<CoreSettings>;
  setSettings(settings: CoreSettingsUpdate): Promise<CoreSettings>;
  getNativeUpdateState(): Promise<NativeUpdateState>;
  checkNativeUpdate(): Promise<NativeUpdateState>;
  downloadNativeUpdate(): Promise<NativeUpdateState>;
  installNativeUpdate(): Promise<NativeUpdateState>;
  retryNativeUpdate(): Promise<NativeUpdateState>;
  copyNativeUpdateDiagnostics(): Promise<NativeUpdateState>;
  openNativeUpdateHelp(): Promise<NativeUpdateState>;
  openNativeUpdateReleases(): Promise<NativeUpdateState>;
  getPrivacyDiagnostics(): Promise<PrivacyDiagnosticReport>;
  inspectLegacyIntegrations(): Promise<CoreLegacyIntegrationInspection>;
  previewLegacyCleanup(): Promise<CoreLegacyCleanupPreview>;
  applyLegacyCleanup(
    planId: string,
    confirmed: true,
  ): Promise<CoreLegacyCleanupResult>;
  resumeSession(sessionKey: string): Promise<ResumeRouteResult>;
  onIndexStatus(callback: (status: IndexStatus) => void): () => void;
  onFocusSearch(callback: () => void): () => void;
  onOpenSettings(callback: () => void): () => void;
  onNativeUpdateState(callback: (state: NativeUpdateState) => void): () => void;
}
