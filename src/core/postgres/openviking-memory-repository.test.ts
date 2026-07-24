import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../session-store";
import { PostgresDatabase } from "./database";
import { PostgresOpenVikingMemoryRepository } from "./openviking-memory-repository";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";

describe("PostgresOpenVikingMemoryRepository", () => {
  let database: PostgresDatabase;
  let repository: PostgresOpenVikingMemoryRepository;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
    repository = new PostgresOpenVikingMemoryRepository(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("stores one stable OpenViking workspace mapping per directory", async () => {
    const created = await repository.addWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/app",
      identity: "repo:github.com/acme/app",
      displayName: "app",
    });

    await expect(repository.listWorkspaces()).resolves.toEqual([created]);
    await expect(repository.getWorkspace("workspace-1")).resolves.toEqual(created);
    await expect(repository.findWorkspaceByRootPath("/projects/app")).resolves.toEqual(created);
    await expect(repository.findWorkspaceByIdentity("repo:github.com/acme/app")).resolves.toEqual(created);
    await expect(repository.addWorkspace({
      id: "workspace-2",
      userId: "workspace_other",
      rootPath: "/projects/app",
      identity: "path:other",
      displayName: "duplicate",
    })).rejects.toThrow();
  });

  it("relinks a moved workspace while keeping its OpenViking user", async () => {
    await repository.addWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/old",
      identity: "repo:github.com/acme/app",
      displayName: "old",
    });

    const relinked = await repository.relinkWorkspace("workspace-1", "/projects/new", "new");

    expect(relinked).toMatchObject({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/new",
      displayName: "new",
    });
    await expect(repository.setWorkspaceManaged("workspace-1", false)).resolves.toMatchObject({
      id: "workspace-1",
      managed: false,
    });
  });

  it("persists resumable import state and deduplicates accepted turns", async () => {
    await repository.addWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/app",
      identity: "repo:github.com/acme/app",
      displayName: "app",
    });

    await repository.updateImportJob("workspace-1", {
      state: "running",
      importedTurns: 3,
      totalTurns: 8,
      cursorSessionKey: "codex:session-2",
      lastError: null,
    });
    await repository.recordImportedTurn("workspace-1", "codex:session-1:0", "turn-hash");
    await repository.recordImportedTurn("workspace-1", "codex:session-1:0", "turn-hash");

    await expect(repository.getWorkspace("workspace-1")).resolves.toMatchObject({
      importState: "running",
      importedTurns: 3,
      totalTurns: 8,
    });
    await expect(repository.getImportJob("workspace-1")).resolves.toMatchObject({
      cursorSessionKey: "codex:session-2",
      lastError: null,
    });
    await expect(repository.hasImportedTurn("workspace-1", "codex:session-1:0", "turn-hash")).resolves.toBe(true);
    await expect(repository.countImportedTurns("workspace-1")).resolves.toBe(1);
  });

  it("cascades import checkpoints when a workspace is deleted", async () => {
    await repository.addWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/app",
      identity: "path:workspace-1",
      displayName: "app",
    });
    await repository.recordImportedTurn("workspace-1", "claude:session-1:0", "hash");

    await expect(repository.deleteWorkspace("workspace-1")).resolves.toBe(true);
    await expect(repository.countImportedTurns("workspace-1")).resolves.toBe(0);
    await expect(repository.getWorkspace("workspace-1")).resolves.toBeNull();
  });

  it("is exposed through SessionStore without leaking database details", async () => {
    const store = new SessionStore(database);
    const created = await store.addOpenVikingWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/app",
      identity: "path:workspace-1",
      displayName: "app",
    });

    await expect(store.listOpenVikingWorkspaces()).resolves.toEqual([created]);
    await expect(store.findOpenVikingWorkspaceByRootPath("/projects/app")).resolves.toEqual(created);
    await expect(store.findOpenVikingWorkspaceByIdentity("path:workspace-1")).resolves.toEqual(created);
    await expect(store.setOpenVikingWorkspaceManaged("workspace-1", false)).resolves.toMatchObject({
      managed: false,
    });
    await store.updateOpenVikingImportJob("workspace-1", {
      state: "paused",
      importedTurns: 1,
      totalTurns: 4,
      cursorSessionKey: null,
      lastError: null,
    });
    await expect(store.getOpenVikingWorkspace("workspace-1")).resolves.toMatchObject({
      importState: "paused",
      importedTurns: 1,
    });
  });
});
