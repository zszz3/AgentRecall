import { describe, expect, it } from "vitest";

import type { OpenVikingMemoryItem } from "../../../../core/openviking-memory";
import { groupOpenVikingMemories } from "./openviking-memory-groups";

function memory(id: string, source?: string): OpenVikingMemoryItem {
  return {
    id,
    workspaceId: "workspace-1",
    title: id.split("/").at(-1) ?? id,
    content: "",
    ...(source ? { source } : {}),
  };
}

describe("groupOpenVikingMemories", () => {
  it("uses stable OpenViking category order while preserving item order", () => {
    const groups = groupOpenVikingMemories([
      memory("viking://user/memories/trajectories/second.md", "trajectories"),
      memory("viking://user/memories/cases/first.md", "cases"),
      memory("viking://user/memories/trajectories/third.md", "trajectories"),
      memory("viking://user/memories/preferences/user/theme.md", "preferences"),
    ]);

    expect(groups.map((group) => [group.key, group.memories.length])).toEqual([
      ["preferences", 1],
      ["cases", 1],
      ["trajectories", 2],
    ]);
    expect(groups[2].memories.map((item) => item.id)).toEqual([
      "viking://user/memories/trajectories/second.md",
      "viking://user/memories/trajectories/third.md",
    ]);
  });

  it("combines identity files and handles manual and unknown memories", () => {
    const groups = groupOpenVikingMemories([
      memory("viking://user/memories/identity.md", "identity.md"),
      memory("viking://user/memories/soul.md", "soul.md"),
      memory("viking://user/memories/manual/note.md"),
      memory("viking://user/memories/custom/note.md", "custom"),
      memory("", undefined),
    ]);

    expect(groups.map((group) => [group.key, group.memories.length])).toEqual([
      ["identity", 2],
      ["manual", 2],
      ["other", 1],
    ]);
  });

  it("uses the memory URI category for semantic results with provenance sources", () => {
    const groups = groupOpenVikingMemories([
      memory("viking://user/memories/events/2026/07/24/imported.md", "session-123"),
    ]);

    expect(groups[0].key).toBe("events");
  });

  it("falls back to source when an item has no OpenViking memory URI", () => {
    const groups = groupOpenVikingMemories([
      memory("opaque-memory-id", "cases"),
    ]);

    expect(groups[0].key).toBe("cases");
  });
});
