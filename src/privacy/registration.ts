import {
  collectPrivacyDiagnostics,
  type PrivacyDiagnosticInput,
  type PrivacyDiagnosticReport,
} from "./diagnostics";
import {
  applyLegacyCleanup,
  inspectLegacyIntegrations,
  previewLegacyCleanup,
  type LegacyCleanupPlan,
  type LegacyCleanupResult,
  type LegacyIntegrationInspection,
} from "./legacy-integrations";
import {
  createReadOnlyUpstreamSessionApi,
  type ReadOnlyUpstreamSessionApi,
  type UpstreamSessionReader,
} from "./read-only-sessions";
import {
  activateAfterFirstWindowReady,
  type OptionalRuntimeActivation,
  type OptionalRuntimeDependencies,
  type OptionalRuntimePolicy,
} from "./runtime-policy";

export interface PrivacyDiagnosticsRegistration<Summary, Detail> {
  readonly contractVersion: 1;
  readonly upstreamSessions: ReadOnlyUpstreamSessionApi<Summary, Detail>;
  afterFirstWindowReady(
    policy: OptionalRuntimePolicy,
    dependencies: OptionalRuntimeDependencies,
  ): Promise<OptionalRuntimeActivation>;
  inspectLegacy(options: { homeDir: string }): Promise<LegacyIntegrationInspection>;
  previewLegacyCleanup(options: {
    homeDir: string;
    backupRoot: string;
    now?: Date;
    idFactory?: () => string;
  }): Promise<LegacyCleanupPlan>;
  applyLegacyCleanup(plan: LegacyCleanupPlan, confirmationToken: string): Promise<LegacyCleanupResult>;
  collectDiagnostics(input: PrivacyDiagnosticInput): Promise<PrivacyDiagnosticReport>;
}

/**
 * Independent adapter for a future main-process/IPC integration. No Electron,
 * renderer, SessionStore, or global HOME dependency is imported here.
 */
export function createPrivacyDiagnosticsRegistration<Summary, Detail>(
  upstreamReader: UpstreamSessionReader<Summary, Detail>,
): PrivacyDiagnosticsRegistration<Summary, Detail> {
  return Object.freeze({
    contractVersion: 1 as const,
    upstreamSessions: createReadOnlyUpstreamSessionApi(upstreamReader),
    afterFirstWindowReady: activateAfterFirstWindowReady,
    inspectLegacy: inspectLegacyIntegrations,
    previewLegacyCleanup,
    applyLegacyCleanup,
    collectDiagnostics: collectPrivacyDiagnostics,
  });
}
