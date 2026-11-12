import { describe, expect, test, vi } from "vitest";

import { registerExperienceCardsIpc, type ExperienceCardsIpcService } from "./experience-cards";

describe("experience cards IPC", () => {
  test("passes validated edits to the service and rejects empty or unknown fields", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const editCard = vi.fn(async () => ({ id: "card-1" }));
    registerExperienceCardsIpc({
      handle: (channel, listener) => {
        handlers.set(channel, listener as (...args: unknown[]) => unknown);
        return undefined as never;
      },
      removeHandler: (channel) => { handlers.delete(channel); },
    }, { editCard } as unknown as ExperienceCardsIpcService);
    const edit = handlers.get("experience-cards:edit");

    const valid = { problem: "问题", solution: "做法", failedAttempts: [], keywords: ["pglite"] };
    await expect(edit?.({}, "card-1", valid)).resolves.toEqual({ id: "card-1" });
    expect(editCard).toHaveBeenCalledWith("card-1", valid);

    await expect(Promise.resolve().then(() => edit?.({}, "card-1", { ...valid, solution: "  " }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => edit?.({}, "card-1", { ...valid, status: "active" }))).rejects.toThrow();
    expect(editCard).toHaveBeenCalledOnce();
  });
});
