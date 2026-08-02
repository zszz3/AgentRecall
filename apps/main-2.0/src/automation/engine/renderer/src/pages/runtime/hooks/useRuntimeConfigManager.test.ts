import { describe, expect, test } from "vitest";
import {
  codexRuntimeAvailability,
  configChannelUserReference,
  confirmConfigSwitch,
} from "./useRuntimeConfigManager";

describe("codexRuntimeAvailability", () => {
  test("returns undetected before runtime probing completes", () => {
    expect(codexRuntimeAvailability([])).toEqual({
      detected: false,
      available: false,
      message: "",
    });
  });

  test("returns a friendly unavailable message when Codex CLI detection fails", () => {
    expect(
      codexRuntimeAvailability([
        {
          id: "codex",
          label: "Codex",
          command: "codex",
          version: null,
          available: false,
          error: "spawn codex ENOENT",
        },
      ]),
    ).toEqual({
      detected: true,
      available: false,
      message: "Codex CLI unavailable: spawn codex ENOENT",
    });
  });
});

describe("confirmConfigSwitch", () => {
  test("saves dirty config before switching and stops when the user cancels", async () => {
    const save = async () => undefined;
    await expect(confirmConfigSwitch(false, () => false, save)).resolves.toBe(true);
    await expect(confirmConfigSwitch(true, () => false, save)).resolves.toBe(false);
    await expect(confirmConfigSwitch(true, () => true, save)).resolves.toBe(true);
  });
});

describe("configChannelUserReference", () => {
  test("finds managed and user-created Agent references", () => {
    const managed = {
      id: "runtime-agent:hermes-default",
      channelId: "hermes-default",
      managed: true,
    };
    const userCreated = {
      id: "worker",
      channelId: "hermes-default",
    };

    expect(configChannelUserReference([managed] as never, "hermes-default")).toBe(managed);
    expect(configChannelUserReference([userCreated] as never, "hermes-default")).toBe(userCreated);
  });
});
