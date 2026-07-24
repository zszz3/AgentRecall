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
    expect(mainSource).toContain("reconcileOpenVikingMemoryHooks");
    expect(mainSource).toContain("refreshOpenVikingHookManifest");
    expect(mainSource.indexOf("store = new SessionStore")).toBeLessThan(
      mainSource.indexOf("initializeOpenVikingMemory();"),
    );
    expect(mainSource).not.toContain("registerAgentMemoryIpc");
    expect(mainSource).not.toContain("new AgentMemoryService");
    expect(preloadSource).not.toContain("createAgentMemoryApi");
    expect(preloadSource).toContain("createOpenVikingMemoryApi");
  });
});
