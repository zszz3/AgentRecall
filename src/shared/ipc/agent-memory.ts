import { z } from "zod";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const relativePathInput = z.string().trim().min(1).max(32_768).refine((value) => !value.includes("\0"), "Path must not contain NUL.");
const contentInput = z.string().max(1_048_576);
const targetInput = z.enum(["codex", "claude", "cursor"]);
const targetsInput = z.array(targetInput).min(1).max(3)
  .refine((targets) => new Set(targets).size === targets.length, "Sync targets must be unique.");
const operationIdInput = z.string().trim().min(1).max(128);
const createInput = z.object({
  kind: z.enum(["agents", "claude", "cursor"]),
  fileName: z.string().trim().min(1).max(84).optional(),
}).strict();

export const AGENT_MEMORY_IPC = {
  choose: defineIpcRequest("agent-memory:choose-directory", noInput),
  refresh: defineIpcRequest("agent-memory:refresh", noInput),
  read: defineIpcRequest("agent-memory:read", z.tuple([relativePathInput])),
  save: defineIpcRequest("agent-memory:save", z.tuple([relativePathInput, contentInput])),
  create: defineIpcRequest("agent-memory:create", z.tuple([createInput])),
  effectiveContext: defineIpcRequest("agent-memory:effective-context", z.tuple([targetInput])),
  previewSync: defineIpcRequest("agent-memory:preview-sync", z.tuple([relativePathInput, targetsInput])),
  applySync: defineIpcRequest("agent-memory:apply-sync", z.tuple([operationIdInput])),
  undoSync: defineIpcRequest("agent-memory:undo-sync", z.tuple([operationIdInput])),
} as const;
