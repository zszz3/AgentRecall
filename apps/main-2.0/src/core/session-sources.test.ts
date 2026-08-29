import { describe, expect, it } from "vitest";
import { sessionSourceDescriptor } from "./session-sources";

describe("StepCode session source semantics", () => {
  it("keeps StepCode sources in their native Claude/Codex families", () => {
    expect(sessionSourceDescriptor("stepcode-claude")).toMatchObject({
      family: "claude",
      pendingKey: "stepcode",
    });
    expect(sessionSourceDescriptor("stepcode-codex")).toMatchObject({
      family: "codex",
      pendingKey: "stepcode",
    });
  });

  it("keeps Qwen Code opt-in and read-only", () => {
    expect(sessionSourceDescriptor("qwen-code")).toMatchObject({
      label: "Qwen Code",
      format: "qwen",
      optionalSetting: "includeQwenCode",
      capabilities: { live: false, resume: false, migrate: false, sessionSync: false, openApp: false },
    });
  });

  it("keeps legacy Qoder IDE sessions as a separate opt-in read-only source", () => {
    expect(sessionSourceDescriptor("qoder-ide")).toMatchObject({
      label: "Qoder IDE",
      format: "qoder",
      family: "qoder-ide",
      optionalSetting: "includeQoderIde",
      pendingKey: "qoder-ide",
      liveFamily: null,
      remoteFamily: null,
      capabilities: { live: false, resume: false, migrate: false, sessionSync: false, openApp: false },
    });
  });
});
