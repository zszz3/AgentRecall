import { describe, expect, it, vi } from "vitest";

import {
  detectRosettaTranslation,
  resolveOpenVikingRuntimeArchitecture,
} from "./openviking-runtime-architecture";

describe("OpenViking runtime architecture", () => {
  it("selects the native arm64 runtime when the app runs through Rosetta", () => {
    expect(resolveOpenVikingRuntimeArchitecture({
      platform: "darwin",
      processArch: "x64",
      isRosettaTranslated: () => true,
    })).toBe("arm64");
  });

  it("keeps Intel and non-macOS process architectures unchanged", () => {
    expect(resolveOpenVikingRuntimeArchitecture({
      platform: "darwin",
      processArch: "x64",
      isRosettaTranslated: () => false,
    })).toBe("x64");
    const translated = vi.fn(() => true);
    expect(resolveOpenVikingRuntimeArchitecture({
      platform: "win32",
      processArch: "x64",
      isRosettaTranslated: translated,
    })).toBe("x64");
    expect(translated).not.toHaveBeenCalled();
  });

  it("reads Apple's Rosetta translation flag and treats unavailable flags as native", () => {
    expect(detectRosettaTranslation(() => "1\n")).toBe(true);
    expect(detectRosettaTranslation(() => "0\n")).toBe(false);
    expect(detectRosettaTranslation(() => {
      throw new Error("missing sysctl flag");
    })).toBe(false);
  });
});
