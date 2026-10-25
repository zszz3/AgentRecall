import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("OpenViking main-process wiring", () => {
  it("keeps startup ordering, hook cleanup, and configured extraction routes", async () => {
    const mainSource = await readFile(path.join(process.cwd(), "src/main/index.ts"), "utf8");
    expect(mainSource).toContain("openVikingHookStateFlusher.start()");
    expect(mainSource).toContain("openVikingHookStateFlusher?.stop()");
    expect(mainSource).toContain("openVikingHookManifestService?.clear()");
    expect(mainSource).toContain(
      'const codexAuthBootstrapPath = codexAuthPath(process.env, app.getPath("home"))',
    );
    // Extraction must read the Codex directory the user configured, not just the bootstrap
    // default, or a custom config dir silently falls back to an unauthenticated route.
    expect(mainSource).toContain(
      "const configuredCodexHome = settings.apiConfig.customConfigDir.trim() || codexHome",
    );
    expect(mainSource).toContain("loadActiveCodexSummaryEndpointDefaults(configuredCodexHome)");
    // The Codex summary source keeps its own directory, and extraction has to read that one
    // rather than the Codex tab's, or memory extraction and summaries use different routes.
    expect(mainSource).toContain(
      "const summaryCodexHome = settings.summaryCodexConfigDir.trim() || codexHome",
    );
    expect(mainSource).toContain("loadActiveCodexSummaryEndpointDefaults(summaryCodexHome)");
    expect(mainSource).toContain(
      "resolveOpenVikingExtractionConfig({ settings, codex, codexEndpoint })",
    );
    expect(mainSource.indexOf("store = new SessionStore")).toBeLessThan(
      mainSource.indexOf("initializeOpenVikingMemory();"),
    );
    expect(mainSource.indexOf("initializeOpenVikingMemory();")).toBeLessThan(
      mainSource.indexOf("reconcileOpenVikingMemoryHooks(getSettings());"),
    );
    expect(mainSource.indexOf("reconcileOpenVikingMemoryHooks(getSettings());")).toBeLessThan(
      mainSource.indexOf("const initialIndexSettled"),
    );
  });
});
