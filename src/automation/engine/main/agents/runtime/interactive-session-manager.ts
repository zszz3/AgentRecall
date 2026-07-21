import type { InteractiveSession, InteractiveSessionContext } from "./runtime-driver";
import { ProcessLease } from "../shared/process-lease";

interface InteractiveSessionManagerOptions {
  createSession: (context: InteractiveSessionContext) => InteractiveSession;
  now: () => number;
}

interface ManagedInteractiveSession {
  session: InteractiveSession;
  queue: Promise<void>;
  lease: ProcessLease;
}

export class InteractiveSessionManager {
  private readonly sessions = new Map<string, ManagedInteractiveSession>();

  constructor(private readonly options: InteractiveSessionManagerOptions) {}

  getOrCreate(chatId: string, context: InteractiveSessionContext): InteractiveSession {
    return this.getOrCreateManaged(chatId, context).session;
  }

  private getOrCreateManaged(chatId: string, context: InteractiveSessionContext): ManagedInteractiveSession {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;
    const session = this.options.createSession(context);
    const managed = {
      session,
      queue: Promise.resolve(),
      lease: new ProcessLease(session.snapshot().runtimeState.attachmentGeneration),
    };
    this.sessions.set(chatId, managed);
    return managed;
  }

  async dispatch(
    chatId: string,
    context: InteractiveSessionContext,
    work: (session: InteractiveSession, lease: ProcessLease) => Promise<void>,
  ): Promise<void>;
  async dispatch(chatId: string, work: (session: InteractiveSession, lease: ProcessLease) => Promise<void>): Promise<void>;
  async dispatch(
    chatId: string,
    contextOrWork: InteractiveSessionContext | ((session: InteractiveSession, lease: ProcessLease) => Promise<void>),
    maybeWork?: (session: InteractiveSession, lease: ProcessLease) => Promise<void>,
  ): Promise<void> {
    const managed =
      typeof contextOrWork === "function"
        ? this.sessions.get(chatId)
        : this.getOrCreateManaged(chatId, contextOrWork);
    if (!managed) throw new Error(`Unknown interactive session: ${chatId}`);

    const work = typeof contextOrWork === "function" ? contextOrWork : maybeWork;
    if (!work) throw new Error(`Interactive session dispatch for ${chatId} is missing work.`);

    const run = managed.queue.catch(() => undefined).then(async () => {
      if (typeof contextOrWork !== "function") {
        managed.session.reconfigure(contextOrWork);
      }
      await work(managed.session, managed.lease);
    });
    managed.queue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  async interrupt(chatId: string): Promise<void> {
    const managed = this.sessions.get(chatId);
    if (!managed) return;
    await managed.session.interrupt();
  }

  async dispose(chatId: string, reason: "idle_timeout" | "app_shutdown" | "error"): Promise<void> {
    const managed = this.sessions.get(chatId);
    if (!managed) return;
    this.sessions.delete(chatId);
    const run = managed.queue.catch(() => undefined).then(() => managed.session.detach(reason));
    managed.queue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  async disposeAll(reason: "idle_timeout" | "app_shutdown" | "error"): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((chatId) => this.dispose(chatId, reason)));
  }

  async sweepExpiredSessions(now = this.options.now()): Promise<void> {
    for (const [chatId, managed] of this.sessions) {
      const snapshot = managed.session.snapshot().runtimeState;
      const lastMeaningfulActivityAt = snapshot.lastMeaningfulActivityAt;
      if (
        (snapshot.attachmentState === "idle" || snapshot.attachmentState === "interrupted") &&
        lastMeaningfulActivityAt !== undefined &&
        now - lastMeaningfulActivityAt > 60 * 60 * 1000
      ) {
        await this.dispatch(chatId, (session) =>
          session.detachIfStillExpired({
            expectedGeneration: snapshot.attachmentGeneration,
            expectedLastMeaningfulActivityAt: lastMeaningfulActivityAt,
            reason: "idle_timeout",
          }),
        );
      }
    }
  }
}
