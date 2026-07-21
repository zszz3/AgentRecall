import { describe, expect, it, vi } from "vitest";
import type {
  AgentMemoryDocument,
  AgentMemorySnapshot,
  CreateAgentMemoryInput,
} from "../../core/agent-memory";
import type {
  AgentMemoryEffectiveContext,
  AgentMemorySyncPreview,
  PreparedAgentMemorySync,
  PreparedAgentMemoryUndo,
} from "../../core/agent-memory-sync";
import { AgentMemoryService, type AgentMemoryOperations } from "./agent-memory-service";

const document: AgentMemoryDocument = {
  relativePath: "AGENTS.md",
  scopeDirectory: "",
  name: "AGENTS.md",
  kind: "agents",
  size: 7,
  modifiedAt: 1,
  content: "# Rules",
};

const snapshot: AgentMemorySnapshot = {
  rootPath: "/repo",
  selectedDirectoryPath: "/repo/apps/web",
  selectedDirectory: "apps/web",
  files: [document],
  directories: ["", "apps", "apps/web"],
  scannedAt: 1,
};

const effectiveContext: AgentMemoryEffectiveContext = {
  target: "codex",
  sources: [document],
  content: "<!-- Source: AGENTS.md -->\n# Rules",
};

const syncPreview: AgentMemorySyncPreview = {
  id: "preview-1",
  sourceRelativePath: "AGENTS.md",
  items: [{
    target: "claude",
    relativePath: "apps/web/CLAUDE.md",
    action: "create",
    diff: [],
  }],
};

const preparedSync: PreparedAgentMemorySync = { preview: syncPreview, changes: [] };
const preparedUndo: PreparedAgentMemoryUndo = { id: "undo-1", changes: [] };

function createHarness() {
  const operations: AgentMemoryOperations = {
    scanDirectory: vi.fn(async () => snapshot),
    readFile: vi.fn(async () => document),
    saveFile: vi.fn(async () => document),
    createFile: vi.fn(async () => document),
    loadEffectiveContext: vi.fn(async () => effectiveContext),
    prepareSync: vi.fn(async () => preparedSync),
    applySync: vi.fn(async () => preparedUndo),
    undoSync: vi.fn(async () => undefined),
  };
  const service = new AgentMemoryService({
    chooseDirectory: vi.fn(async () => "/repo/apps/web"),
    operations,
  });
  return { service, operations };
}

describe("AgentMemoryService", () => {
  it("lets the user choose a directory and keeps later operations inside that selection", async () => {
    const { service, operations } = createHarness();
    const createInput: Omit<CreateAgentMemoryInput, "directory"> = { kind: "claude" };

    await expect(service.choose()).resolves.toEqual(snapshot);
    await service.read("AGENTS.md");
    await service.save("AGENTS.md", "# Rules");
    await service.create(createInput);

    expect(operations.scanDirectory).toHaveBeenCalledWith("/repo/apps/web");
    expect(operations.readFile).toHaveBeenCalledWith("/repo", "AGENTS.md");
    expect(operations.saveFile).toHaveBeenCalledWith("/repo", "AGENTS.md", "# Rules");
    expect(operations.createFile).toHaveBeenCalledWith("/repo", { directory: "apps/web", kind: "claude" });
  });

  it("requires an explicit directory selection before reading or writing", async () => {
    const { service, operations } = createHarness();

    await expect(service.refresh()).resolves.toBeNull();
    await expect(service.read("AGENTS.md")).rejects.toThrow(/choose a directory/i);
    await expect(service.save("AGENTS.md", "unsafe")).rejects.toThrow(/choose a directory/i);
    expect(operations.scanDirectory).not.toHaveBeenCalled();
    expect(operations.saveFile).not.toHaveBeenCalled();
  });

  it("keeps sync previews and one-step undo scoped to the current directory selection", async () => {
    const { service, operations } = createHarness();
    await service.choose();

    await expect(service.effectiveContext("codex")).resolves.toEqual(effectiveContext);
    await expect(service.previewSync("AGENTS.md", ["claude"])).resolves.toEqual(syncPreview);
    await expect(service.applySync("another-preview")).rejects.toThrow(/refresh the sync preview/i);

    const applied = await service.applySync("preview-1");
    expect(applied.undoId).toBe("undo-1");
    expect(applied.changedPaths).toEqual(["apps/web/CLAUDE.md"]);
    expect(operations.applySync).toHaveBeenCalledWith("/repo", preparedSync);

    await expect(service.undoSync("another-undo")).rejects.toThrow(/no longer available/i);
    await expect(service.undoSync("undo-1")).resolves.toEqual(snapshot);
    expect(operations.undoSync).toHaveBeenCalledWith("/repo", preparedUndo);
    await expect(service.undoSync("undo-1")).rejects.toThrow(/no longer available/i);
  });
});
