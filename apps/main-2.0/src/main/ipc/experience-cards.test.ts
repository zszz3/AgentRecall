import { describe, expect, test, vi } from "vitest";

import { registerExperienceCardsIpc, type ExperienceCardsIpcService } from "./experience-cards";

describe("experience cards IPC", () => {
  test("passes validated list options and card ids to the service and offers no way to edit a card", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const listCards = vi.fn(async () => []);
    const deleteCard = vi.fn(async () => undefined);
    registerExperienceCardsIpc({
      handle: (channel, listener) => {
        handlers.set(channel, listener as (...args: unknown[]) => unknown);
        return undefined as never;
      },
      removeHandler: (channel) => { handlers.delete(channel); },
    }, { listCards, deleteCard } as unknown as ExperienceCardsIpcService);

    expect([...handlers.keys()].sort()).toEqual(["experience-cards:get-status", "experience-cards:list", "experience-cards:remove", "experience-cards:retry-failed"]);
    await handlers.get("experience-cards:list")?.({}, { query: "pglite", includeSuperseded: true });
    expect(listCards).toHaveBeenCalledWith({ query: "pglite", includeSuperseded: true });
    await expect(Promise.resolve().then(() => handlers.get("experience-cards:list")?.({}, { query: "", includeSuperseded: true, status: "active" }))).rejects.toThrow();
    await handlers.get("experience-cards:remove")?.({}, "card-1");
    expect(deleteCard).toHaveBeenCalledWith("card-1");
    await expect(Promise.resolve().then(() => handlers.get("experience-cards:remove")?.({}, ""))).rejects.toThrow();
  });
});
