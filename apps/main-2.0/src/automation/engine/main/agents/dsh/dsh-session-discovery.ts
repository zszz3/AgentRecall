import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DSH_HOME_NAME = ".dsh";
const DISCOVERY_INTERVAL_MS = 100;
const discoveryTails = new Map<string, Promise<void>>();

export interface DshSessionDiscoveryHandle {
  prepare(signal: AbortSignal): Promise<void> | void;
  observe(): void;
  finish(): Promise<void>;
}

interface DshSessionDiscoveryDependencies {
  readSessionIds: (sessionsRoot: string) => Promise<Set<string>>;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

function abortError(): Error {
  const error = new Error("DSH Session discovery was cancelled.");
  error.name = "AbortError";
  return error;
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const handleAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    void previous.then(
      () => {
        signal.removeEventListener("abort", handleAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

async function acquireDiscoveryTurn(key: string, signal: AbortSignal): Promise<() => void> {
  const previous = discoveryTails.get(key) ?? Promise.resolve();
  let releaseSlot!: () => void;
  const slot = new Promise<void>((resolve) => {
    releaseSlot = resolve;
  });
  const tail = previous.then(() => slot);
  discoveryTails.set(key, tail);
  try {
    await waitForTurn(previous, signal);
  } catch (error) {
    releaseSlot();
    void tail.then(() => {
      if (discoveryTails.get(key) === tail) discoveryTails.delete(key);
    });
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseSlot();
    if (discoveryTails.get(key) === tail) discoveryTails.delete(key);
  };
}

async function readDshSessionIds(sessionsRoot: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let projects;
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ids;
    throw error;
  }
  await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (project) => {
    let sessions;
    try {
      sessions = await readdir(join(sessionsRoot, project.name), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const session of sessions) {
      if (session.isDirectory() && session.name) ids.add(session.name);
    }
  }));
  return ids;
}

export function dshSessionsRoot(environment: NodeJS.ProcessEnv): string {
  const dshHome = environment.DSH_HOME?.trim() || join(homedir(), DEFAULT_DSH_HOME_NAME);
  return join(dshHome, "sessions");
}

/**
 * Attributes the one fresh Session created by an official DSH headless run.
 * AgentRecall serializes only this short discovery window. More than one new
 * Session is intentionally left unbound because ownership would be ambiguous.
 */
export class DshSessionDiscovery implements DshSessionDiscoveryHandle {
  private baseline: Set<string> | undefined;
  private releaseTurn: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<void> = Promise.resolve();
  private discoveryError: unknown;
  private observing = false;
  private reported = false;

  constructor(
    private readonly sessionsRoot: string,
    private readonly onSessionId: (sessionId: string) => void,
    private readonly dependencies: DshSessionDiscoveryDependencies = {
      readSessionIds: readDshSessionIds,
      setInterval,
      clearInterval,
    },
  ) {}

  async prepare(signal: AbortSignal): Promise<void> {
    this.releaseTurn = await acquireDiscoveryTurn(this.sessionsRoot, signal);
    try {
      this.baseline = await this.dependencies.readSessionIds(this.sessionsRoot);
    } catch (error) {
      this.release();
      throw error;
    }
  }

  observe(): void {
    if (!this.baseline || this.timer) return;
    this.observing = true;
    this.timer = this.dependencies.setInterval(() => {
      this.enqueueCheck();
    }, DISCOVERY_INTERVAL_MS);
    this.enqueueCheck();
  }

  async finish(): Promise<void> {
    this.clearTimer();
    if (this.observing) this.enqueueCheck();
    try {
      await this.checking;
    } finally {
      this.release();
    }
    if (this.discoveryError !== undefined) throw this.discoveryError;
  }

  private enqueueCheck(): void {
    if (!this.baseline || this.reported || this.discoveryError) return;
    this.checking = this.checking
      .then(async () => {
        if (!this.baseline || this.reported || this.discoveryError) return;
        const current = await this.dependencies.readSessionIds(this.sessionsRoot);
        const created = [...current].filter((sessionId) => !this.baseline?.has(sessionId));
        if (created.length !== 1) return;
        this.reported = true;
        this.onSessionId(created[0]!);
        this.clearTimer();
        this.release();
      })
      .catch((error: unknown) => {
        this.discoveryError ??= error;
        this.clearTimer();
        this.release();
      });
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.dependencies.clearInterval(this.timer);
    this.timer = undefined;
  }

  private release(): void {
    this.releaseTurn?.();
    this.releaseTurn = undefined;
  }
}
