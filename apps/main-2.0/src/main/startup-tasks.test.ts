import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartupTaskScheduler } from "./startup-tasks";

describe("startup task scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs scheduled tasks after their delay", () => {
    vi.useFakeTimers();
    const scheduler = createStartupTaskScheduler(() => false);
    const task = vi.fn();
    scheduler.schedule(100, task);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(task).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("cancels all pending tasks on cancelAll", () => {
    vi.useFakeTimers();
    const scheduler = createStartupTaskScheduler(() => false);
    const first = vi.fn();
    const second = vi.fn();
    scheduler.schedule(50, first);
    scheduler.schedule(200, second);
    scheduler.cancelAll();
    vi.advanceTimersByTime(500);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("skips tasks that fire after quit started", () => {
    vi.useFakeTimers();
    let quitting = false;
    const scheduler = createStartupTaskScheduler(() => quitting);
    const task = vi.fn();
    scheduler.schedule(100, task);
    quitting = true;
    vi.advanceTimersByTime(100);
    expect(task).not.toHaveBeenCalled();
  });

  it("runs settled tasks once the promise resolves", async () => {
    const scheduler = createStartupTaskScheduler(() => false);
    const task = vi.fn();
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    scheduler.whenSettled(settled, task);
    await Promise.resolve();
    expect(task).not.toHaveBeenCalled();
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("skips settled tasks when quit started before the promise resolved", async () => {
    let quitting = false;
    const scheduler = createStartupTaskScheduler(() => quitting);
    const task = vi.fn();
    scheduler.whenSettled(Promise.resolve(), task);
    quitting = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(task).not.toHaveBeenCalled();
  });
});
