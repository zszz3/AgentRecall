import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OpenVikingClientPort } from "./openviking-client";
import type { OpenVikingCredentialStorePort } from "./openviking-memory-service";

interface OpenVikingHookStateFlusherOptions {
  stateDir: string;
  client: Pick<OpenVikingClientPort, "commitSession">;
  credentials: Pick<OpenVikingCredentialStorePort, "get">;
  idleMs?: number;
  intervalMs?: number;
}

interface HookSessionState {
  workspaceId?: string;
  sessionId?: string;
  pendingTokenEstimate?: number;
  updatedAt?: string;
  [key: string]: unknown;
}

const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_INTERVAL_MS = 30_000;

export class OpenVikingHookStateFlusher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(private readonly options: OpenVikingHookStateFlusherOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flushIdle().catch(() => {
        // Pending state remains on disk and will be retried by the next sweep.
      });
    }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async flushIdle(now = Date.now()): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      let names: string[];
      try {
        names = (await readdir(this.options.stateDir)).filter((name) => name.endsWith(".json"));
      } catch {
        return;
      }
      for (const name of names) {
        await this.flushFile(path.join(this.options.stateDir, name), now);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async flushFile(filePath: string, now: number): Promise<void> {
    let state: HookSessionState;
    try {
      state = JSON.parse(await readFile(filePath, "utf8")) as HookSessionState;
    } catch {
      return;
    }
    const pending = Number(state.pendingTokenEstimate || 0);
    const updatedAt = Date.parse(state.updatedAt || "");
    if (
      pending <= 0
      || !state.workspaceId
      || !state.sessionId
      || !Number.isFinite(updatedAt)
      || now - updatedAt < (this.options.idleMs ?? DEFAULT_IDLE_MS)
    ) return;
    const auth = await this.options.credentials.get(state.workspaceId);
    if (!auth) return;
    try {
      await this.options.client.commitSession(auth, state.sessionId);
    } catch {
      return;
    }

    let current: HookSessionState;
    try {
      current = JSON.parse(await readFile(filePath, "utf8")) as HookSessionState;
    } catch {
      return;
    }
    if (current.updatedAt !== state.updatedAt || Number(current.pendingTokenEstimate || 0) !== pending) return;
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({
        ...current,
        pendingTokenEstimate: 0,
        pendingSince: null,
        lastCommittedAt: new Date(now).toISOString(),
      })}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
