import { describe, expect, test } from "vitest";
import { codexRuntimeAvailability, confirmConfigSwitch } from "./useRuntimeConfigManager";

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
