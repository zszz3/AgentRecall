import { describe, expect, it } from "vitest";
import { resolveRuntimeExecutables } from "../main/agents/runtime/detect";
import {
  RUNTIME_IDS,
  isRuntimeId,
  runtimeDefinition,
  runtimeSupportsCustomMcp,
} from "./runtime-catalog";

describe("runtime catalog", () => {
  it("registers DeepSeek Harness as an optional detected CLI runtime", () => {
    expect(RUNTIME_IDS).toContain("dsh");
    expect(isRuntimeId("dsh")).toBe(true);
    expect(runtimeDefinition("dsh")).toEqual({
      id: "dsh",
      label: "DeepSeek Harness",
      executable: "dsh",
      executableEnv: "DSH_PATH",
      detection: "cli",
      localConfigImport: true,
      autoCreateConfig: false,
      persistDefaultConfig: true,
      supportsCustomMcp: false,
      defaultChannel: {
        id: "dsh-default",
        label: "DeepSeek Harness",
        presetId: "dsh-default",
      },
    });
  });

  it("resolves DSH_PATH ahead of the catalog executable", () => {
    expect(resolveRuntimeExecutables({}, { DSH_PATH: "/opt/dsh-preview" }).dsh).toBe("/opt/dsh-preview");
    expect(resolveRuntimeExecutables({}, {}).dsh).toBe("dsh");
    expect(resolveRuntimeExecutables({ dsh: "/explicit/dsh" }, { DSH_PATH: "/env/dsh" }).dsh)
      .toBe("/explicit/dsh");
    expect(resolveRuntimeExecutables({}, { DSH_PATH: "C:\\tools\\dsh.cmd" }).dsh)
      .toBe("C:\\tools\\dsh.cmd");
  });

  it("declares custom MCP injection support instead of assuming every runtime accepts it", () => {
    expect(Object.fromEntries(RUNTIME_IDS.map((runtimeId) => [
      runtimeId,
      runtimeSupportsCustomMcp(runtimeId),
    ]))).toEqual({
      codex: true,
      claude: true,
      dsh: false,
      api: false,
      hermes: true,
      opencode: true,
      openclaw: true,
    });
  });
});
