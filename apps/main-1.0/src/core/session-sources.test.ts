import { describe, expect, it } from "vitest";
import {
  isSessionSource,
  OPTIONAL_SESSION_SOURCE_DESCRIPTORS,
  remoteSessionAgentForSource,
  SESSION_SOURCE_DESCRIPTORS,
  SESSION_SOURCE_REGISTRY,
  sessionSourceDescriptor,
} from "./session-sources";
import type { SessionSource } from "./types";

const ALL_SOURCES = [
  "claude-cli",
  "claude-app",
  "codex-cli",
  "codex-app",
  "tclaude-cli",
  "tcodex-cli",
  "codebuddy-cli",
  "workbuddy-cli",
  "codewiz-cli",
  "openclaw",
  "hermes",
  "opencode-cli",
  "zcode-cli",
  "cursor-agent",
  "trae",
  "qoder",
  "pi-cli",
  "kimi-cli",
  "deepseek-cli",
] as const satisfies readonly SessionSource[];

describe("session source capability registry", () => {
  it("contains every SessionSource exactly once with a matching id", () => {
    expect(Object.keys(SESSION_SOURCE_REGISTRY)).toEqual(ALL_SOURCES);
    expect(SESSION_SOURCE_DESCRIPTORS.map(({ id }) => id)).toEqual(ALL_SOURCES);
    for (const source of ALL_SOURCES) expect(sessionSourceDescriptor(source).id).toBe(source);
  });

  it("keeps capability flags consistent with their declared handlers", () => {
    for (const descriptor of SESSION_SOURCE_DESCRIPTORS) {
      expect(descriptor.capabilities.live).toBe(descriptor.liveFamily !== null);
      expect(descriptor.capabilities.migrate).toBe(descriptor.migrationAgent !== null);
      // Migrating targets sync remotely; deepseek migrates locally only.
      if (descriptor.migrationAgent !== null && descriptor.remoteFamily !== null) {
        expect(descriptor.capabilities.sessionSync).toBe(true);
      }
      expect(descriptor.capabilities.openApp).toBe(descriptor.nativeAppFamily !== null);
      if (descriptor.capabilities.resume) expect(descriptor.resumeTarget).not.toBeNull();
      if (descriptor.remoteCollectorOptional) expect(descriptor.optionalSetting).not.toBeNull();
    }
  });

  it("owns optional settings, live families, portable agents, and remote collector gates", () => {
    expect(OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map(({ optionalSetting }) => optionalSetting)).toEqual([
      "includeTclaude",
      "includeTcodex",
      "includeCodeBuddyCli",
      "includeWorkBuddy",
      "includeCodeWizCli",
      "includeOpenClaw",
      "includeHermes",
      "includeOpenCode",
      "includeZcode",
      "includeCursorAgent",
      "includeTrae",
      "includeQoder",
      "includePi",
      "includeKimiCli",
      "includeDeepSeekCli",
    ]);
    expect(sessionSourceDescriptor("tclaude-cli")).toMatchObject({ liveFamily: "tclaude", migrationAgent: "claude" });
    expect(sessionSourceDescriptor("tcodex-cli")).toMatchObject({ liveFamily: "tcodex", migrationAgent: "codex" });
    expect(sessionSourceDescriptor("qoder")).toMatchObject({ format: "qoder", liveFamily: "qoder", remoteFamily: "qoder" });
    expect(sessionSourceDescriptor("hermes")).toMatchObject({
      migrationAgent: null,
      capabilities: { live: true, resume: false, migrate: false, sessionSync: true, openApp: false },
    });
    expect(sessionSourceDescriptor("zcode-cli")).toMatchObject({
      format: "zcode",
      uiFamily: "zcode",
      optionalSetting: "includeZcode",
      liveFamily: "zcode",
      capabilities: { live: true, resume: false, migrate: false, sessionSync: false, openApp: false },
    });
    expect(sessionSourceDescriptor("workbuddy-cli")).toMatchObject({
      label: "WorkBuddy",
      format: "workbuddy",
      family: "workbuddy",
      uiFamily: "other",
      optionalSetting: "includeWorkBuddy",
      pendingKey: "workbuddy",
      remoteCollectorOptional: false,
      liveFamily: null,
      migrationAgent: null,
      resumeTarget: null,
      remoteFamily: null,
      nativeAppFamily: null,
      capabilities: { live: false, resume: false, migrate: false, sessionSync: false, openApp: false },
    });
    expect(sessionSourceDescriptor("pi-cli")).toMatchObject({
      label: "Pi",
      format: "pi",
      family: "pi",
      uiFamily: "other",
      optionalSetting: "includePi",
      liveFamily: null,
      migrationAgent: null,
      remoteFamily: null,
      capabilities: {
        live: false,
        resume: false,
        migrate: false,
        sessionSync: true,
        openApp: false,
      },
    });
    expect(remoteSessionAgentForSource("pi-cli")).toBe("pi");
    expect(remoteSessionAgentForSource("hermes")).toBe("hermes");
    expect(remoteSessionAgentForSource("zcode-cli")).toBeNull();
    expect(remoteSessionAgentForSource("workbuddy-cli")).toBeNull();
    expect(OPTIONAL_SESSION_SOURCE_DESCRIPTORS.filter(({ remoteCollectorOptional }) => remoteCollectorOptional).map(({ id }) => id)).toEqual([
      "tclaude-cli",
      "tcodex-cli",
      "codebuddy-cli",
      "qoder",
    ]);
  });

  it("validates unknown source values without fallback classification", () => {
    expect(isSessionSource("qoder")).toBe(true);
    expect(isSessionSource("unknown-agent")).toBe(false);
    expect(isSessionSource(null)).toBe(false);
  });
});
