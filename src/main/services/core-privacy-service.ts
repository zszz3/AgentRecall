import { existsSync } from "node:fs";
import type { AppSettings } from "../../core/platform";
import type { SessionStore } from "../../core/session-store";
import type { NativeUpdateState } from "../../distribution/native-update-types";
import {
  collectPrivacyDiagnostics,
  sanitizeDiagnosticValue,
} from "../../privacy/diagnostics";
import {
  createPrivacyDiagnosticsRegistration,
} from "../../privacy/registration";
import type { LegacyCleanupPlan } from "../../privacy/legacy-integrations";
import type {
  CoreLegacyCleanupPreview,
  CoreLegacyCleanupResult,
  CoreLegacyIntegrationInspection,
} from "../../shared/core-api";
import { CORE_SESSION_SOURCES, isCoreSessionSource } from "../../shared/product-profile";
import type { PrivacyIpcService } from "../ipc/privacy";

export interface CorePrivacyServiceOptions {
  getStore(): SessionStore;
  getSettings(): AppSettings;
  getNativeUpdateState(): NativeUpdateState;
  version: string;
  homeDir: string;
  userDataPath: string;
  databasePath: string;
  backupRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  osRelease?: string;
}

export function createCorePrivacyService(
  options: CorePrivacyServiceOptions,
): PrivacyIpcService {
  const registration = createPrivacyDiagnosticsRegistration({
    list: () => options.getStore().searchSessions({
      environmentId: "local",
      allowedSources: CORE_SESSION_SOURCES,
      excludeSubagents: options.getSettings().hideSubagentSessions,
      limit: 1_000,
    }),
    read: (sessionKey: string) => {
      const session = options.getStore().getSession(sessionKey);
      return session
        && session.environmentId === "local"
        && session.environmentKind === "local"
        && isCoreSessionSource(session.source)
        ? session
        : null;
    },
  });
  const retainedPlans = new Map<string, LegacyCleanupPlan>();
  const sanitize = <T>(value: T): T =>
    sanitizeDiagnosticValue(value, {
      homeDir: options.homeDir,
      pathMode: "home",
    }) as T;

  return {
    async diagnostics() {
      const settings = options.getSettings();
      const update = options.getNativeUpdateState();
      const sources = CORE_SESSION_SOURCES.map((source) => ({
        source,
        count: options.getStore().searchSessionPage({
          environmentId: "local",
          source,
          allowedSources: CORE_SESSION_SOURCES,
          excludeSubagents: settings.hideSubagentSessions,
          limit: 1,
        }).totalCount,
        status: "healthy" as const,
      }));
      return collectPrivacyDiagnostics({
        version: options.version,
        homeDir: options.homeDir,
        platform: options.platform,
        arch: options.arch,
        osRelease: options.osRelease,
        data: {
          status: existsSync(options.userDataPath) ? "healthy" : "degraded",
          path: options.userDataPath,
        },
        database: {
          status: existsSync(options.databasePath) ? "healthy" : "degraded",
          path: options.databasePath,
        },
        sources,
        cli: [
          {
            name: "claude",
            available: false,
            path: settings.claudeBinary,
            error: "Availability is not probed by privacy diagnostics.",
          },
          {
            name: "codex",
            available: false,
            path: settings.codexBinary,
            error: "Availability is not probed by privacy diagnostics.",
          },
        ],
        terminal: {
          selected: settings.defaultTerminal,
          available: true,
          detail: "Configured terminal preference.",
        },
        update: {
          automaticChecksEnabled: settings.autoCheckUpdates,
          status: update.phase,
          currentVersion: update.currentVersion,
          availableVersion: update.targetVersion ?? undefined,
          errorCode: update.failure?.code ?? null,
          error: update.failure?.message ?? null,
        },
        pathMode: "home",
      });
    },

    async inspectLegacy(): Promise<CoreLegacyIntegrationInspection> {
      const inspection = await registration.inspectLegacy({
        homeDir: options.homeDir,
      });
      return sanitize({
        findings: inspection.findings,
        issues: inspection.issues,
      });
    },

    async previewLegacyCleanup(): Promise<CoreLegacyCleanupPreview> {
      const plan = await registration.previewLegacyCleanup({
        homeDir: options.homeDir,
        backupRoot: options.backupRoot,
      });
      retainedPlans.clear();
      retainedPlans.set(plan.planId, plan);
      return sanitize({
        planId: plan.planId,
        createdAt: plan.createdAt,
        backupLocation: plan.backupRoot,
        requiresConfirmation: true as const,
        actions: plan.actions.map((action) => ({
          filePath: action.filePath,
          description: action.description,
          findingCount: action.findingIds.length,
        })),
        issues: plan.issues,
      });
    },

    async applyLegacyCleanup(
      planId: string,
      confirmed: true,
    ): Promise<CoreLegacyCleanupResult> {
      if (confirmed !== true) {
        throw new Error("Legacy cleanup requires explicit confirmation.");
      }
      const plan = retainedPlans.get(planId);
      if (!plan) {
        throw new Error("Legacy cleanup preview expired. Preview the changes again.");
      }
      retainedPlans.delete(planId);
      const result = await registration.applyLegacyCleanup(
        plan,
        plan.confirmationToken,
      );
      return sanitize(result);
    },
  };
}
