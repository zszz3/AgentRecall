import type { SessionSource } from "../core/types";

export const CORE_PRODUCT_PROFILE_ID = "core-v1" as const;

export const CORE_SESSION_SOURCES = [
  "claude-cli",
  "claude-app",
  "codex-cli",
  "codex-app",
] as const satisfies readonly SessionSource[];

export type CoreSessionSource = (typeof CORE_SESSION_SOURCES)[number];

export interface ProductProfile {
  readonly id: typeof CORE_PRODUCT_PROFILE_ID;
  readonly sessionSources: readonly CoreSessionSource[];
  readonly capabilities: {
    readonly search: true;
    readonly filters: true;
    readonly details: true;
    readonly resume: true;
    readonly favorites: true;
    readonly rename: true;
    readonly settings: true;
    readonly about: true;
    readonly updates: true;
  };
  readonly disabledCapabilities: {
    readonly sshEnvironments: true;
    readonly remoteSessionSync: true;
    readonly skillUsage: true;
    readonly sessionSyncQueue: true;
    readonly providers: true;
    readonly codexProxy: true;
    readonly tokenQuota: true;
    readonly aiSummary: true;
    readonly aiAssistant: true;
    readonly sessionMigration: true;
    readonly mcpAutoConfiguration: true;
    readonly hookAutoInstallation: true;
    readonly statusLineAutoInstallation: true;
  };
}

/**
 * The only production Product Profile. Keep product composition decisions here
 * so the main process, preload, renderer, and tests share one immutable boundary.
 */
export const PRODUCT_PROFILE: ProductProfile = Object.freeze({
  id: CORE_PRODUCT_PROFILE_ID,
  sessionSources: Object.freeze([...CORE_SESSION_SOURCES]),
  capabilities: Object.freeze({
    search: true,
    filters: true,
    details: true,
    resume: true,
    favorites: true,
    rename: true,
    settings: true,
    about: true,
    updates: true,
  }),
  disabledCapabilities: Object.freeze({
    sshEnvironments: true,
    remoteSessionSync: true,
    skillUsage: true,
    sessionSyncQueue: true,
    providers: true,
    codexProxy: true,
    tokenQuota: true,
    aiSummary: true,
    aiAssistant: true,
    sessionMigration: true,
    mcpAutoConfiguration: true,
    hookAutoInstallation: true,
    statusLineAutoInstallation: true,
  }),
});

const CORE_SESSION_SOURCE_SET = new Set<string>(CORE_SESSION_SOURCES);

export function isCoreSessionSource(source: unknown): source is CoreSessionSource {
  return typeof source === "string" && CORE_SESSION_SOURCE_SET.has(source);
}
