import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { EnvironmentStore } from "./environments";
import { migrateSessionStore } from "./schema";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

describe("EnvironmentStore", () => {
  it("keeps generated SSH ids distinct and reuses an existing host alias", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new EnvironmentStore(db);
      const first = store.upsertEnvironment({
        kind: "ssh",
        label: "devbox",
        host: "dev-a.example.com",
      });
      const second = store.upsertEnvironment({
        kind: "ssh",
        label: "devbox",
        host: "dev-b.example.com",
      });
      const aliased = store.upsertEnvironment({
        kind: "ssh",
        label: "production",
        hostAlias: "prod",
        host: "prod-a.example.com",
      });
      const updatedAlias = store.upsertEnvironment({
        kind: "ssh",
        label: "production-updated",
        hostAlias: "prod",
        host: "prod-b.example.com",
      });

      expect(first.id).toBe("devbox");
      expect(second.id).toBe("devbox-2");
      expect(updatedAlias.id).toBe(aliased.id);
      expect(store.getEnvironment(aliased.id)).toMatchObject({
        label: "production-updated",
        host: "prod-b.example.com",
      });
    } finally {
      db.close();
    }
  });

  it("preserves omitted sync fields, clears explicit values, and protects local", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new EnvironmentStore(db);
      const environment = store.upsertEnvironment({ kind: "ssh", label: "devbox", host: "dev.example.com" });
      store.updateEnvironmentSyncState(environment.id, "error", {
        lastSyncedAt: 10,
        lastError: "connection failed",
      });
      store.updateEnvironmentSyncState(environment.id, "watching");
      expect(store.getEnvironment(environment.id)).toMatchObject({
        syncState: "watching",
        lastSyncedAt: 10,
        lastError: "connection failed",
      });

      store.updateEnvironmentSyncState(environment.id, "idle", { lastError: null });
      expect(store.getEnvironment(environment.id)).toMatchObject({ syncState: "idle", lastError: null });
      expect(() => store.deleteEnvironment("local")).toThrow("Local environment cannot be deleted");
    } finally {
      db.close();
    }
  });

  it("persists WSL distributions independently from SSH fields", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new EnvironmentStore(db);
      const ubuntu = store.upsertEnvironment({ kind: "wsl", label: "WSL · Ubuntu", wslDistribution: " Ubuntu " });
      const debian = store.upsertEnvironment({ kind: "wsl", label: "WSL · Debian", wslDistribution: "Debian" });
      const updated = store.upsertEnvironment({ kind: "wsl", label: "Ubuntu updated", wslDistribution: "Ubuntu" });

      expect(updated.id).toBe(ubuntu.id);
      expect(store.listEnvironments()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ubuntu.id, kind: "wsl", wslDistribution: "Ubuntu", host: null, hostAlias: null }),
        expect.objectContaining({ id: debian.id, kind: "wsl", wslDistribution: "Debian" }),
      ]));
      expect(() => store.upsertEnvironment({ kind: "wsl", label: "Missing" })).toThrow("WSL distribution is required");
    } finally {
      db.close();
    }
  });
});
