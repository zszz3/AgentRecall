import { describe, expect, it } from "vitest";
import {
  isSessionSource,
  OPTIONAL_SESSION_SOURCE_DESCRIPTORS,
  SESSION_SOURCE_DESCRIPTORS,
  SESSION_SOURCE_REGISTRY,
  sessionSourceDescriptor,
} from "./session-sources";
import type { SessionSource } from "./types";

const ALL_SOURCES = [
  "claude-cli",
  "claude-app",
  "claude-internal",
  "codex-cli",
  "codex-app",
  "codex-internal",
  "tclaude-cli",
  "tcodex-cli",
  "codebuddy-cli",
  "codewiz-cli",
  "openclaw",
  "hermes",
  "opencode-cli",
  "zcode-cli",
  "cursor-agent",
  "trae",
  "qoder",
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
      expect(descriptor.capabilities.sessionSync).toBe(descriptor.migrationAgent !== null);
      expect(descriptor.capabilities.openApp).toBe(descriptor.nativeAppFamily !== null);
      if (descriptor.capabilities.resume) expect(descriptor.resumeTarget).not.toBeNull();
      if (descriptor.remoteCollectorOptional) expect(descriptor.optionalSetting).not.toBeNull();
    }
  });

  it("owns optional settings, live families, portable agents, and remote collector gates", () => {
    expect(OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map(({ optionalSetting }) => optionalSetting)).toEqual([
      "includeClaudeInternal",
      "includeCodexInternal",
      "includeTclaude",
      "includeTcodex",
      "includeCodeBuddyCli",
      "includeCodeWizCli",
      "includeOpenClaw",
      "includeHermes",
      "includeOpenCode",
      "includeZcode",
      "includeCursorAgent",
      "includeTrae",
      "includeQoder",
    ]);
    expect(sessionSourceDescriptor("tclaude-cli")).toMatchObject({ liveFamily: "tclaude", migrationAgent: "claude" });
    expect(sessionSourceDescriptor("tcodex-cli")).toMatchObject({ liveFamily: "tcodex", migrationAgent: "codex" });
    expect(sessionSourceDescriptor("qoder")).toMatchObject({ format: "qoder", liveFamily: "qoder", remoteFamily: "qoder" });
    expect(sessionSourceDescriptor("zcode-cli")).toMatchObject({
      format: "zcode",
      uiFamily: "zcode",
      optionalSetting: "includeZcode",
      capabilities: { live: false, resume: false, migrate: false, sessionSync: false, openApp: false },
    });
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
