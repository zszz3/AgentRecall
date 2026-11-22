import { describe, expect, it } from "vitest";

import { settlePendingSettings } from "./pending-settings";

describe("settlePendingSettings", () => {
  it("clears the submitted keys and keeps unrelated pending keys", () => {
    expect(settlePendingSettings(
      { defaultTerminal: "iTerm", evalEnabled: true },
      { defaultTerminal: "iTerm" },
    )).toEqual({ evalEnabled: true });
  });

  it("keeps a key the user changed again while the save was in flight", () => {
    expect(settlePendingSettings(
      { globalShortcut: "Ctrl+Alt+Space" },
      { globalShortcut: "Alt+Space" },
    )).toEqual({ globalShortcut: "Ctrl+Alt+Space" });
  });
});
