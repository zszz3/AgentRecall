import { describe, expect, it, vi } from "vitest";
import { configChannelsEqual } from "../../../../../shared/config-channels";
import type { AgentChannel } from "../../../../../shared/types";
import { confirmConfigSwitch } from "./useRuntimeConfigManager";

const CHANNEL: AgentChannel = {
  id: "codex-config",
  agentId: "codex",
  label: "Codex",
  models: [{ id: "default", label: "Default" }],
};

describe("Runtime unsaved config handling", () => {
  it("does not treat equivalent objects from an unchanged blur event as edits", () => {
    expect(configChannelsEqual([CHANNEL], [{ ...CHANNEL, models: CHANNEL.models.map((model) => ({ ...model })) }])).toBe(true);
  });

  it("distinguishes a real field edit from the saved snapshot", () => {
    expect(configChannelsEqual([CHANNEL], [{ ...CHANNEL, label: "Changed" }])).toBe(false);
  });

  it("returns to the saved state after an added channel is removed again", () => {
    const added = [...[CHANNEL], { ...CHANNEL, id: "temporary-config" }];
    expect(configChannelsEqual([CHANNEL], added)).toBe(false);
    expect(configChannelsEqual([CHANNEL], added.filter((channel) => channel.id !== "temporary-config"))).toBe(true);
  });

  it("supports save, discard, and cancel as separate leave decisions", async () => {
    const save = vi.fn(async () => undefined);
    const discard = vi.fn();

    await expect(confirmConfigSwitch(true, async () => "cancel", save, discard)).resolves.toBe(false);
    await expect(confirmConfigSwitch(true, async () => "discard", save, discard)).resolves.toBe(true);
    await expect(confirmConfigSwitch(true, async () => "save", save, discard)).resolves.toBe(true);

    expect(discard).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a decision when the current config is unchanged", async () => {
    const decide = vi.fn(async () => "save" as const);
    const save = vi.fn(async () => undefined);
    const discard = vi.fn();

    await expect(confirmConfigSwitch(false, decide, save, discard)).resolves.toBe(true);

    expect(decide).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });
});
