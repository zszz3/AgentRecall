import type { SessionStore } from "./session-store";
import type { EnvironmentUpsertInput, SessionEnvironment } from "./types";

export interface RemoteEnvironmentWatchManager {
  start(environment: SessionEnvironment): void;
  stop(environmentId: string): void;
  stopAll(): void;
}

export interface RemoteEnvironmentLifecycleOptions {
  store: SessionStore;
  syncEnvironment: (environment: SessionEnvironment) => Promise<void>;
  watchManager: RemoteEnvironmentWatchManager;
  onEnvironmentsUpdated?: (environments: SessionEnvironment[]) => void;
}

interface ActiveSync {
  generation: number;
  promise: Promise<void>;
}

interface RequestSyncOptions {
  propagateErrors?: boolean;
}

interface ReconcileResult {
  handledStaleCompletion: boolean;
  syncLatest: boolean;
  dropPending: boolean;
}

export class RemoteEnvironmentLifecycle {
  private readonly store: SessionStore;
  private readonly syncEnvironment: (environment: SessionEnvironment) => Promise<void>;
  private readonly watchManager: RemoteEnvironmentWatchManager;
  private readonly onEnvironmentsUpdated: (environments: SessionEnvironment[]) => void;
  private readonly generations = new Map<string, number>();
  private readonly activeSyncs = new Map<string, ActiveSync>();
  private readonly pendingLatestSyncs = new Set<string>();
  private readonly deletedEnvironmentIds = new Set<string>();

  constructor(options: RemoteEnvironmentLifecycleOptions) {
    this.store = options.store;
    this.syncEnvironment = options.syncEnvironment;
    this.watchManager = options.watchManager;
    this.onEnvironmentsUpdated = options.onEnvironmentsUpdated ?? (() => undefined);
  }

  listEnvironments(): Promise<SessionEnvironment[]> {
    return this.store.listEnvironments();
  }

  async saveEnvironment(input: EnvironmentUpsertInput): Promise<SessionEnvironment> {
    const environment = await this.store.upsertEnvironment(input);
    this.deletedEnvironmentIds.delete(environment.id);
    this.bumpGeneration(environment.id);
    this.watchManager.stop(environment.id);
    if (isEnabledSshEnvironment(environment)) {
      void this.requestSync(environment).catch(() => undefined);
    }
    await this.emitEnvironmentsUpdated();
    return environment;
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    if (environmentId === "local") throw new Error("Local environment cannot be deleted.");
    this.deletedEnvironmentIds.add(environmentId);
    this.bumpGeneration(environmentId);
    this.pendingLatestSyncs.delete(environmentId);
    this.watchManager.stop(environmentId);
    await this.store.deleteEnvironment(environmentId);
    await this.emitEnvironmentsUpdated();
  }

  async refreshEnvironment(environmentId: string): Promise<void> {
    const environment = await this.store.getEnvironment(environmentId);
    if (!environment || !isEnabledSshEnvironment(environment)) return;
    await this.requestSync(environment, { propagateErrors: true });
    await this.waitForIdleOrThrow(environmentId);
  }

  async startEnabledEnvironments(): Promise<void> {
    for (const environment of await this.store.listEnvironments()) {
      if (isEnabledSshEnvironment(environment)) void this.requestSync(environment).catch(() => undefined);
    }
  }

  stopAll(): void {
    this.watchManager.stopAll();
  }

  syncFromWatcher(environment: SessionEnvironment): Promise<void> {
    return this.requestSync(environment);
  }

  async waitForIdle(environmentId: string): Promise<void> {
    for (;;) {
      const active = this.activeSyncs.get(environmentId);
      if (!active) return;
      await active.promise.catch(() => undefined);
    }
  }

  private async requestSync(environment: SessionEnvironment, options: RequestSyncOptions = {}): Promise<void> {
    if (!isEnabledSshEnvironment(environment)) return;
    const current = await this.store.getEnvironment(environment.id);
    if (!current || this.deletedEnvironmentIds.has(environment.id)) return;
    if (!sameEnvironmentConfig(current, environment)) return this.requestSync(current, options);

    const active = this.activeSyncs.get(environment.id);
    if (active) {
      this.pendingLatestSyncs.add(environment.id);
      return options.propagateErrors ? this.waitForIdleOrThrow(environment.id) : this.waitForIdle(environment.id);
    }

    const generation = this.generationFor(environment.id);
    const record: ActiveSync = { generation, promise: Promise.resolve() };
    record.promise = this.runSync(environment, record);
    this.activeSyncs.set(environment.id, record);
    return record.promise;
  }

  private async waitForIdleOrThrow(environmentId: string): Promise<void> {
    let hasSyncError = false;
    let syncErrorValue: unknown;
    for (;;) {
      const active = this.activeSyncs.get(environmentId);
      if (!active) {
        if (hasSyncError) throw syncErrorValue;
        return;
      }
      try {
        await active.promise;
      } catch (error) {
        if (!hasSyncError) {
          hasSyncError = true;
          syncErrorValue = error;
        }
      }
    }
  }

  private async runSync(environment: SessionEnvironment, record: ActiveSync): Promise<void> {
    const environmentId = environment.id;
    let hasSyncError = false;
    let syncErrorValue: unknown;

    try {
      if (!(await this.isCurrent(environment, record.generation))) return;
      const sync = this.syncEnvironment(environment);
      await this.emitEnvironmentsUpdated();
      await sync;
    } catch (error) {
      hasSyncError = true;
      syncErrorValue = error;
    }

    const reconcile = await this.reconcileCompletedSync(environment, record.generation, !hasSyncError);
    if (this.activeSyncs.get(environmentId) === record) this.activeSyncs.delete(environmentId);
    if (reconcile.dropPending) this.pendingLatestSyncs.delete(environmentId);

    if (hasSyncError && !reconcile.handledStaleCompletion) {
      this.pendingLatestSyncs.delete(environmentId);
      await this.store.updateEnvironmentSyncState(environmentId, "error", { lastError: errorMessage(syncErrorValue) });
      await this.emitEnvironmentsUpdated();
      throw syncErrorValue;
    }

    if (reconcile.syncLatest || this.pendingLatestSyncs.has(environmentId)) {
      this.pendingLatestSyncs.delete(environmentId);
      const latest = await this.store.getEnvironment(environmentId);
      if (latest && isEnabledSshEnvironment(latest) && !this.deletedEnvironmentIds.has(environmentId)) {
        await this.requestSync(latest);
      }
    }
  }

  private async reconcileCompletedSync(
    environment: SessionEnvironment,
    generation: number,
    shouldStartWatcher: boolean,
  ): Promise<ReconcileResult> {
    const environmentId = environment.id;
    const current = await this.store.getEnvironment(environmentId);

    if (this.deletedEnvironmentIds.has(environmentId) || !current) {
      await this.store.deleteEnvironment(environmentId);
      await this.emitEnvironmentsUpdated();
      return { handledStaleCompletion: true, syncLatest: false, dropPending: true };
    }

    if (current.kind === "ssh" && !current.enabled) {
      await this.store.updateEnvironmentSyncState(environmentId, "idle", { lastError: null });
      await this.emitEnvironmentsUpdated();
      return { handledStaleCompletion: true, syncLatest: false, dropPending: true };
    }

    if (generation !== this.generationFor(environmentId) && sameRemoteConnectionConfig(current, environment)) {
      if (shouldStartWatcher) {
        await this.emitEnvironmentsUpdated();
        this.watchManager.start(current);
      }
      return { handledStaleCompletion: false, syncLatest: false, dropPending: true };
    }

    if (generation !== this.generationFor(environmentId) || !sameEnvironmentConfig(current, environment)) {
      await this.store.deleteEnvironmentSessions(environmentId);
      await this.emitEnvironmentsUpdated();
      return { handledStaleCompletion: true, syncLatest: true, dropPending: false };
    }

    if (shouldStartWatcher) {
      await this.emitEnvironmentsUpdated();
      this.watchManager.start(current);
    }
    return { handledStaleCompletion: false, syncLatest: false, dropPending: false };
  }

  private async isCurrent(environment: SessionEnvironment, generation: number): Promise<boolean> {
    const current = await this.store.getEnvironment(environment.id);
    return (
      Boolean(current) &&
      !this.deletedEnvironmentIds.has(environment.id) &&
      generation === this.generationFor(environment.id) &&
      sameEnvironmentConfig(current as SessionEnvironment, environment)
    );
  }

  private bumpGeneration(environmentId: string): void {
    this.generations.set(environmentId, this.generationFor(environmentId) + 1);
  }

  private generationFor(environmentId: string): number {
    return this.generations.get(environmentId) ?? 0;
  }

  private async emitEnvironmentsUpdated(): Promise<void> {
    this.onEnvironmentsUpdated(await this.store.listEnvironments());
  }
}

function isEnabledSshEnvironment(environment: SessionEnvironment): boolean {
  return environment.kind === "ssh" && environment.enabled;
}

function sameEnvironmentConfig(a: SessionEnvironment, b: SessionEnvironment): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.hostAlias === b.hostAlias &&
    a.host === b.host &&
    a.user === b.user &&
    a.port === b.port &&
    a.authMode === b.authMode &&
    a.identityFile === b.identityFile &&
    a.enabled === b.enabled
  );
}

function sameRemoteConnectionConfig(a: SessionEnvironment, b: SessionEnvironment): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.hostAlias === b.hostAlias &&
    a.host === b.host &&
    a.user === b.user &&
    a.port === b.port &&
    a.authMode === b.authMode &&
    a.identityFile === b.identityFile &&
    a.enabled === b.enabled
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
