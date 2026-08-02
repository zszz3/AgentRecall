import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenVikingHookStateFlusher } from "./openviking-hook-state-flusher";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenVikingHookStateFlusher", () => {
  it("commits idle pending sessions while leaving active sessions alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-flusher-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    const idlePath = path.join(stateDir, "idle.json");
    const activePath = path.join(stateDir, "active.json");
    await writeFile(idlePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-idle",
      pendingTokenEstimate: 120,
      updatedAt: "2026-07-30T00:00:00.000Z",
    }));
    await writeFile(activePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-active",
      pendingTokenEstimate: 80,
      updatedAt: "2026-07-30T00:02:30.000Z",
    }));
    const commitSession = vi.fn(async () => ({ taskId: "task-1" }));
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      idleMs: 120_000,
      client: { commitSession },
      credentials: {
        get: vi.fn(async () => ({
          accountId: "agent-recall-v2",
          userId: "workspace_user",
          apiKey: "workspace-key",
        })),
      },
    });

    await flusher.flushIdle(Date.parse("2026-07-30T00:03:00.000Z"));

    expect(commitSession).toHaveBeenCalledOnce();
    expect(commitSession).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "workspace-key" }), "session-idle");
    expect(JSON.parse(await readFile(idlePath, "utf8"))).toMatchObject({
      pendingTokenEstimate: 0,
      lastCommittedAt: "2026-07-30T00:03:00.000Z",
    });
    expect(JSON.parse(await readFile(activePath, "utf8"))).toMatchObject({ pendingTokenEstimate: 80 });
  });

  it("keeps failed commits pending and retries them on the next sweep", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-retry-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    const statePath = path.join(stateDir, "pending.json");
    await writeFile(statePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-retry",
      pendingTokenEstimate: 40,
      updatedAt: "2026-07-30T00:00:00.000Z",
    }));
    const commitSession = vi.fn()
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockResolvedValueOnce({ taskId: "task-2" });
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      idleMs: 1,
      client: { commitSession },
      credentials: {
        get: vi.fn(async () => ({
          accountId: "agent-recall-v2",
          userId: "workspace_user",
          apiKey: "workspace-key",
        })),
      },
    });

    await flusher.flushIdle(Date.parse("2026-07-30T00:01:00.000Z"));
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ pendingTokenEstimate: 40 });

    await flusher.flushIdle(Date.parse("2026-07-30T00:02:00.000Z"));
    expect(commitSession).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ pendingTokenEstimate: 0 });
  });
});
