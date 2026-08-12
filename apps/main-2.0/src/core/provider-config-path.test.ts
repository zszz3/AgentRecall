import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProviderConfigDirectory } from "./provider-config-path";

describe("resolveProviderConfigDirectory", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("follows the same local config environment variables as the runtimes", () => {
    vi.stubEnv("CODEX_HOME", path.join(os.tmpdir(), "runtime-codex"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(os.tmpdir(), "runtime-claude"));

    expect(resolveProviderConfigDirectory(undefined, ".codex")).toBe(path.join(os.tmpdir(), "runtime-codex"));
    expect(resolveProviderConfigDirectory(undefined, ".claude")).toBe(path.join(os.tmpdir(), "runtime-claude"));
  });

  it("keeps an explicitly selected directory above the environment default", () => {
    vi.stubEnv("CODEX_HOME", path.join(os.tmpdir(), "runtime-codex"));
    const selected = path.join(os.tmpdir(), "selected-codex");
    expect(resolveProviderConfigDirectory(selected, ".codex")).toBe(selected);
  });
});
