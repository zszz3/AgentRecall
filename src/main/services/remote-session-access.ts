import { loadRemoteSessionDetailPayload, loadWslSessionDetailPayload } from "../../core/remote-session-loader";
import { preflightRemoteSessionResume } from "../../core/remote-health";
import {
  fetchRemoteSessionFilePayload,
} from "../../core/remote-sync";
import { isLocalSessionEnvironment } from "../../core/session-environment";
import type { SessionStore } from "../../core/session-store";
import { buildSshArgs } from "../../core/ssh-config";
import type { SessionEnvironment, SessionSearchResult } from "../../core/types";

export interface RemoteSessionAccessDependencies {
  getStore(): SessionStore;
}

/**
 * Centralizes access to remote Session content and environments.
 *
 * The in-flight map also makes hydration a resource-management boundary:
 * concurrent callers share one remote transfer and its cleanup.
 */
export class RemoteSessionAccess {
  private readonly detailLoads = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: RemoteSessionAccessDependencies) {}

  async requireWslEnvironment(session: SessionSearchResult): Promise<SessionEnvironment> {
    const environment = await this.dependencies.getStore().getEnvironment(session.environmentId);
    if (environment?.kind !== "wsl") {
      throw new Error("WSL environment is not available for this remote session.");
    }
    return environment;
  }

  async requireRemoteSshEnvironment(
    session: SessionSearchResult,
  ): Promise<SessionEnvironment | null> {
    if (isLocalSessionEnvironment(session)) return null;
    const environment = await this.dependencies.getStore().getEnvironment(session.environmentId);
    if (!environment || environment.kind !== "ssh") {
      throw new Error("SSH environment is not available for this remote session.");
    }
    return environment;
  }

  async requireSshEnvironment(environmentId: string): Promise<SessionEnvironment> {
    const environment = await this.dependencies.getStore().getEnvironment(environmentId);
    if (!environment) throw new Error("SSH environment was not found.");
    if (environment.kind !== "ssh") {
      throw new Error("Diagnostics are only available for SSH environments.");
    }
    return environment;
  }

  async requireWslResumeOptions(
    session: SessionSearchResult,
  ): Promise<{ wslDistribution: string }> {
    const environment = await this.requireWslEnvironment(session);
    if (!environment.wslDistribution) {
      throw new Error("WSL distribution is not configured for this remote session.");
    }
    return { wslDistribution: environment.wslDistribution };
  }

  async requireSshArgs(session: SessionSearchResult): Promise<string[] | undefined> {
    const sshArgs = await this.sshArgs(session);
    if (!isLocalSessionEnvironment(session) && !sshArgs) {
      throw new Error("SSH environment is not available for this remote session.");
    }
    return sshArgs;
  }

  async ensureResumePreflight(session: SessionSearchResult): Promise<void> {
    const environment = await this.requireRemoteSshEnvironment(session);
    if (!environment) return;
    const report = await preflightRemoteSessionResume(environment, session);
    const errors = report.checks.filter((check) => check.status === "error");
    if (errors.length === 0) return;
    const detail = errors.map((check) => `${check.label}: ${check.message}`).join("; ");
    throw new Error(`Remote resume preflight failed: ${detail}`);
  }

  async ensureWslResumePreflight(session: SessionSearchResult): Promise<void> {
    const environment = await this.requireWslEnvironment(session);
    const report = await preflightRemoteSessionResume(environment, session);
    const errors = report.checks.filter((check) => check.status === "error");
    if (errors.length > 0) {
      throw new Error(errors.map((check) => `${check.label}: ${check.message}`).join("\n"));
    }
  }

  async hasHydratedDetails(sessionKey: string): Promise<boolean> {
    return (await this.dependencies.getStore().getMessages(sessionKey, 0, 1)).length > 0;
  }

  async ensureDetails(sessionKey: string): Promise<void> {
    const store = this.dependencies.getStore();
    const session = await store.getSession(sessionKey);
    if (!session || isLocalSessionEnvironment(session)) return;
    if (await this.hasHydratedDetails(sessionKey)) return;

    const active = this.detailLoads.get(sessionKey);
    if (active) return active;

    const load = this.loadDetails(sessionKey).finally(() => {
      this.detailLoads.delete(sessionKey);
    });
    this.detailLoads.set(sessionKey, load);
    return load;
  }

  private async sshArgs(session: SessionSearchResult): Promise<string[] | undefined> {
    if (isLocalSessionEnvironment(session)) return undefined;
    const environment = await this.dependencies.getStore().getEnvironment(session.environmentId);
    if (!environment || environment.kind !== "ssh") return undefined;
    try {
      return buildSshArgs(environment, "").slice(0, -1);
    } catch {
      return undefined;
    }
  }

  private async loadDetails(sessionKey: string): Promise<void> {
    const store = this.dependencies.getStore();
    const session = await store.getSession(sessionKey);
    if (!session || isLocalSessionEnvironment(session) || session.source === "codewiz-cli") return;

    const environment = await store.getEnvironment(session.environmentId);
    if (!environment) {
      throw new Error("Remote environment is not available for this session.");
    }
    const payload = await fetchRemoteSessionFilePayload(environment, session);
    if (environment.kind === "wsl") {
      const loaded = loadWslSessionDetailPayload(environment, payload, session);
      if (loaded) {
        await store.upsertIndexedSession(
          loaded.session,
          loaded.messages,
          loaded.tokenEvents,
          loaded.traceEvents,
        );
      }
      return;
    }
    if (environment.kind !== "ssh") {
      throw new Error("SSH environment is not available for this remote session.");
    }
    const loaded = loadRemoteSessionDetailPayload(environment, payload, session);
    if (loaded) {
      await store.upsertIndexedSession(
        loaded.session,
        loaded.messages,
        loaded.tokenEvents,
        loaded.traceEvents,
      );
    }
  }
}
