import { describe, expect, it, vi } from "vitest";

import {
  OPENVIKING_RUNTIME_VERSION,
  resolveOpenVikingRuntimeManifest,
} from "./openviking-artifact-resolver";

describe("OpenViking artifact resolver", () => {
  it("loads the matching runtime manifest from the current AgentRecall release", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify({
      version: OPENVIKING_RUNTIME_VERSION,
      platform: "darwin",
      arch: "arm64",
      sha256: "a".repeat(64),
      archiveType: "tar.gz",
      executablePath: "bin/openviking-server",
      file: `openviking-runtime-${OPENVIKING_RUNTIME_VERSION}-darwin-arm64.tar.gz`,
    }), { status: 200 }));

    await expect(resolveOpenVikingRuntimeManifest({
      appVersion: "0.8.0",
      platform: "darwin",
      arch: "arm64",
      fetchImpl,
    })).resolves.toEqual({
      version: OPENVIKING_RUNTIME_VERSION,
      platform: "darwin",
      arch: "arm64",
      sha256: "a".repeat(64),
      archiveType: "tar.gz",
      executablePath: "bin/openviking-server",
      url: `https://github.com/zszz3/AgentRecall/releases/download/v0.8.0/openviking-runtime-${OPENVIKING_RUNTIME_VERSION}-darwin-arm64.tar.gz`,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://github.com/zszz3/AgentRecall/releases/download/v0.8.0/openviking-runtime-${OPENVIKING_RUNTIME_VERSION}-darwin-arm64.tar.gz.json`,
      expect.objectContaining({ redirect: "follow" }),
    );
  });

  it("returns null when the current build has no runtime artifact", async () => {
    await expect(resolveOpenVikingRuntimeManifest({
      appVersion: "0.8.0",
      platform: "win32",
      arch: "arm64",
      fetchImpl: async () => new Response("not found", { status: 404 }),
    })).resolves.toBeNull();
  });

  it("rejects a mismatched or unsafe release manifest", async () => {
    await expect(resolveOpenVikingRuntimeManifest({
      appVersion: "0.8.0",
      platform: "darwin",
      arch: "arm64",
      fetchImpl: async () => new Response(JSON.stringify({
        version: OPENVIKING_RUNTIME_VERSION,
        platform: "linux",
        arch: "arm64",
        sha256: "a".repeat(64),
        archiveType: "tar.gz",
        executablePath: "bin/openviking-server",
        file: "../runtime.tar.gz",
      })),
    })).rejects.toThrow("does not match");
  });
});
