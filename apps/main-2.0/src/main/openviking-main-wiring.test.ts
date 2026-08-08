import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("OpenViking main-process wiring", () => {
  it("replaces the rules-file memory IPC with the directory memory control plane", async () => {
    const mainSource = await readFile(path.join(process.cwd(), "src/main/index.ts"), "utf8");
    const preloadSource = await readFile(path.join(process.cwd(), "src/preload/index.ts"), "utf8");

    expect(mainSource).toContain("registerOpenVikingMemoryIpc");
    expect(mainSource).toContain("initializeOpenVikingMemory");
    expect(mainSource).toContain("OpenVikingHookManifestService");
    expect(mainSource).toContain("OpenVikingHookStateFlusher");
    expect(mainSource).toContain("openVikingHookStateFlusher.start()");
    expect(mainSource).toContain("openVikingHookStateFlusher?.stop()");
    expect(mainSource).toContain("openVikingHookManifestService?.clear()");
    expect(mainSource).toContain("reconcileOpenVikingMemoryHooks");
    expect(mainSource).toContain("refreshOpenVikingHookManifest");
    expect(mainSource).toContain("snapshot.workspaces.some((workspace) => workspace.managed)");
    expect(mainSource).not.toContain("syncManagedWorkspaces");
    expect(mainSource).toContain("build-openviking-runtime.mjs");
    expect(mainSource).toContain("developmentFallback");
    expect(mainSource).toContain("allowLocalRuntime: !releaseUpdateRuntime");
    expect(mainSource).toContain(
      'const releaseUpdateRuntime = process.env.AGENT_RECALL_RELEASE_BUILD === "1"',
    );
    expect(mainSource).toContain(
      "developmentFallback: releaseUpdateRuntime",
    );
    expect(mainSource).toContain(
      'const codexAuthBootstrapPath = codexAuthPath(process.env, app.getPath("home"))',
    );
    // Extraction must read the Codex directory the user configured, not just the bootstrap
    // default, or a custom config dir silently falls back to an unauthenticated route.
    expect(mainSource).toContain(
      "const configuredCodexHome = settings.apiConfig.customConfigDir.trim() || codexHome",
    );
    expect(mainSource).toContain("loadActiveCodexSummaryEndpointDefaults(configuredCodexHome)");
    expect(mainSource).toContain(
      "resolveOpenVikingExtractionConfig({ settings, codex, codexEndpoint })",
    );
    expect(mainSource.indexOf("store = new SessionStore")).toBeLessThan(
      mainSource.indexOf("initializeOpenVikingMemory();"),
    );
    expect(mainSource).not.toContain("registerAgentMemoryIpc");
    expect(mainSource).not.toContain("new AgentMemoryService");
    expect(preloadSource).not.toContain("createAgentMemoryApi");
    expect(preloadSource).toContain("createOpenVikingMemoryApi");
    expect(preloadSource).not.toContain("importOpenVikingWorkspace");
    expect(preloadSource).not.toContain("listOpenVikingImportSessions");
  });
});
