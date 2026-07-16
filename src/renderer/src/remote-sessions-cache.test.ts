import { describe, expect, it } from "vitest";
import type { RemoteSessionListItem, SessionSyncItem } from "../../core/remote-session-sync";
import type { SessionSearchResult } from "../../core/types";
import { applyRemoteSessionDeletion, applyRemoteSessionUpload } from "./remote-sessions-cache";

const local = {
  sessionKey: "codex:local",
  source: "codex-cli",
  displayTitle: "Cached session",
} as SessionSearchResult;

const remote = {
  id: "remote-1",
  sourceSessionKey: local.sessionKey,
  contentHash: "revision-2",
  syncedAt: 200,
} as RemoteSessionListItem;

describe("remote sessions cache", () => {
  it("updates an uploaded local session without reloading the full comparison list", () => {
    const items: SessionSyncItem[] = [{
      id: `local:${local.sessionKey}`,
      state: "local-only",
      local,
      remote: null,
      localRevision: "revision-1",
      remoteRevision: "",
      lastSyncedAt: null,
    }];

    expect(applyRemoteSessionUpload(items, local.sessionKey, remote)).toEqual([{
      ...items[0],
      id: remote.id,
      state: "synced",
      remote,
      localRevision: remote.contentHash,
      remoteRevision: remote.contentHash,
      lastSyncedAt: remote.syncedAt,
    }]);
  });

  it("removes cloud-only entries and turns paired entries into local-only entries after deletion", () => {
    const paired: SessionSyncItem = {
      id: remote.id,
      state: "synced",
      local,
      remote,
      localRevision: remote.contentHash,
      remoteRevision: remote.contentHash,
      lastSyncedAt: remote.syncedAt,
    };
    const cloudOnly: SessionSyncItem = {
      ...paired,
      id: "remote-only",
      local: null,
      remote: { ...remote, id: "remote-only" },
      state: "remote-only",
      localRevision: "",
    };

    expect(applyRemoteSessionDeletion([paired, cloudOnly], [remote.id, "remote-only"])).toEqual([{
      ...paired,
      id: `local:${local.sessionKey}`,
      state: "local-only",
      remote: null,
      remoteRevision: "",
      lastSyncedAt: null,
    }]);
  });
});
