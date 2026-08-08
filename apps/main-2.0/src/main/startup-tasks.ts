// Startup work is deferred so initial indexing settles first, but the app may
// quit before the timers fire. Untracked timers cannot be cancelled from
// before-quit, so their callbacks can restart services the quit path just
// stopped. This scheduler keeps the timer handles and refuses tasks once quit
// has started.
export interface StartupTaskScheduler {
  schedule(delayMs: number, task: () => void | Promise<void>): void;
  whenSettled(settled: Promise<void>, task: () => void | Promise<void>): void;
  cancelAll(): void;
}

export function createStartupTaskScheduler(isQuitting: () => boolean): StartupTaskScheduler {
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  function runUnlessQuitting(task: () => void | Promise<void>): void {
    if (isQuitting()) return;
    void task();
  }

  return {
    schedule(delayMs, task) {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        runUnlessQuitting(task);
      }, delayMs);
      pendingTimers.add(timer);
    },
    whenSettled(settled, task) {
      void settled.then(() => runUnlessQuitting(task));
    },
    cancelAll() {
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
    },
  };
}
