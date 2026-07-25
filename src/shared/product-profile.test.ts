import { describe, expect, it } from "vitest";
import {
  CORE_PRODUCT_PROFILE_ID,
  CORE_SESSION_SOURCES,
  PRODUCT_PROFILE,
  isCoreSessionSource,
} from "./product-profile";

const EXPECTED_CORE_SOURCES = [
  "claude-cli",
  "claude-app",
  "codex-cli",
  "codex-app",
] as const;

const EXPECTED_CORE_CAPABILITIES = [
  "search",
  "filters",
  "details",
  "resume",
  "favorites",
  "rename",
  "settings",
  "about",
  "updates",
] as const;

const EXPECTED_DISABLED_CAPABILITIES = [
  "sshEnvironments",
  "remoteSessionSync",
  "skillUsage",
  "sessionSyncQueue",
  "providers",
  "codexProxy",
  "tokenQuota",
  "aiSummary",
  "aiAssistant",
  "sessionMigration",
  "mcpAutoConfiguration",
  "hookAutoInstallation",
  "statusLineAutoInstallation",
] as const;

describe("core-v1 product profile", () => {
  it("is the single immutable production profile with an exact capability list", () => {
    expect(PRODUCT_PROFILE.id).toBe("core-v1");
    expect(CORE_PRODUCT_PROFILE_ID).toBe("core-v1");
    expect(PRODUCT_PROFILE.sessionSources).toEqual(EXPECTED_CORE_SOURCES);
    expect(CORE_SESSION_SOURCES).toEqual(EXPECTED_CORE_SOURCES);
    expect(Object.keys(PRODUCT_PROFILE.capabilities)).toEqual(EXPECTED_CORE_CAPABILITIES);
    expect(Object.keys(PRODUCT_PROFILE.disabledCapabilities)).toEqual(EXPECTED_DISABLED_CAPABILITIES);
    expect(Object.values(PRODUCT_PROFILE.capabilities)).toEqual(
      EXPECTED_CORE_CAPABILITIES.map(() => true),
    );
    expect(Object.values(PRODUCT_PROFILE.disabledCapabilities)).toEqual(
      EXPECTED_DISABLED_CAPABILITIES.map(() => true),
    );
    expect(Object.isFrozen(PRODUCT_PROFILE)).toBe(true);
    expect(Object.isFrozen(PRODUCT_PROFILE.sessionSources)).toBe(true);
    expect(Object.isFrozen(PRODUCT_PROFILE.capabilities)).toBe(true);
    expect(Object.isFrozen(PRODUCT_PROFILE.disabledCapabilities)).toBe(true);
  });

  it("recognizes only the four local Claude Code and Codex sources", () => {
    for (const source of EXPECTED_CORE_SOURCES) {
      expect(isCoreSessionSource(source)).toBe(true);
    }
    for (const source of [
      "claude-internal",
      "codex-internal",
      "tclaude-cli",
      "tcodex-cli",
      "codebuddy-cli",
      "codewiz-cli",
      "openclaw",
      "hermes",
      "opencode-cli",
      "cursor-agent",
      "trae",
      "",
      null,
      undefined,
    ]) {
      expect(isCoreSessionSource(source)).toBe(false);
    }
  });
});
