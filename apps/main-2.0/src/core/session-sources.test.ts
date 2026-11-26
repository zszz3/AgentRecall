import { describe, expect, it } from "vitest";
import { remoteSessionAgentForSource, sessionSourceDescriptor, supportsAiSummarySource } from "./session-sources";

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

  it("keeps Antigravity opt-in and read-only", () => {
    expect(sessionSourceDescriptor("antigravity")).toMatchObject({
      label: "Antigravity",
      format: "antigravity",
      family: "antigravity",
      uiFamily: "other",
      optionalSetting: "includeAntigravity",
      pendingKey: "antigravity",
      liveFamily: null,
      remoteFamily: null,
      capabilities: { live: false, resume: false, migrate: false, sessionSync: false, openApp: false },
    });
  });

  it("keeps Antigravity CLI opt-in, read-only on disk, and resumable via agy CLI", () => {
    expect(sessionSourceDescriptor("antigravity-cli")).toMatchObject({
      label: "Antigravity CLI",
      format: "antigravity-cli",
      family: "antigravity-cli",
      uiFamily: "other",
      optionalSetting: "includeAntigravityCli",
      pendingKey: "antigravity-cli",
      liveFamily: null,
      remoteFamily: null,
      capabilities: { live: false, resume: true, migrate: false, sessionSync: false, openApp: false },
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

  it("disables AI summaries only for CodeWiz sessions", () => {
    expect(supportsAiSummarySource("codewiz-cli")).toBe(false);
    expect(supportsAiSummarySource("codex-cli")).toBe(true);
  });
});

describe("ZCode session source semantics", () => {
  it("allows local migration while retaining the resume and remote-sync boundaries", () => {
    expect(sessionSourceDescriptor("zcode-cli")).toMatchObject({
      migrationAgent: "zcode",
      capabilities: { live: true, resume: false, migrate: true, sessionSync: false, openApp: false },
    });
    expect(remoteSessionAgentForSource("zcode-cli")).toBeNull();
  });
});
