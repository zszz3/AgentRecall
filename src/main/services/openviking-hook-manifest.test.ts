import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OpenVikingHookManifestService } from "./openviking-hook-manifest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenVikingHookManifestService", () => {
  it("writes only managed workspace credentials to an app-owned mode-0600 manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-manifest-"));
    roots.push(root);
    await chmod(root, 0o700);
    const service = new OpenVikingHookManifestService({
      rootDir: root,
      realpath: async (value) => value,
      credentials: {
        get: async (workspaceId) => workspaceId === "managed"
          ? {
              accountId: "agent-recall",
              userId: "workspace_user",
              apiKey: "workspace-key",
            }
          : null,
      },
    });

    const manifestPath = await service.write({
      baseUrl: "http://127.0.0.1:21933",
      integrations: { claude: true, codex: false, opencode: true },
      workspaces: [
        workspace("managed", true),
        workspace("retained", false),
      ],
    });

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.workspaces).toEqual([expect.objectContaining({
      id: "managed",
      apiKey: "workspace-key",
    })]);
    if (process.platform !== "win32") {
      expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    }
  });
});

function workspace(id: string, managed: boolean) {
  return {
    id,
    userId: `user_${id}`,
    rootPath: `/projects/${id}`,
    identity: `path:${id}`,
    displayName: id,
    managed,
    importState: "completed" as const,
    importedTurns: 1,
    totalTurns: 1,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
}
