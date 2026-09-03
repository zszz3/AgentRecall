import { z } from "zod";

import { tryCanonicalOpenVikingMemoryUri } from "../../core/openviking-memory";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const pathInput = z.string().trim().min(1).max(32_768)
  .refine((value) => !value.includes("\0"), "Path must not contain NUL.");
const workspaceIdInput = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9_-]+$/u, "Workspace ID is invalid.");
const queryInput = z.string().trim().max(2_000);
const memoryUriInput = z.string().trim().min(1).max(8_192)
  .refine(
    (value) => tryCanonicalOpenVikingMemoryUri(value) !== null,
    "Memory URI must stay under the user memory scope.",
  );
const sessionArtifactUriInput = z.string().trim().min(1).max(8_192)
  .refine(
    (value) => value.startsWith("viking://user/")
      && !value.includes("\0")
      && !value.includes("\\")
      && !value.includes("?")
      && !value.includes("#")
      && !value.split("/").some((segment) => segment === "." || segment === ".."),
    "Session artifact URI is invalid.",
  );
const memoryInput = z.object({
  id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  uri: memoryUriInput.optional(),
  title: z.string().trim().min(1).max(200),
  content: z.string().max(1_048_576),
}).strict();
const feedbackInput = z.object({
  feedback: z.enum(["helpful", "wrong", "outdated"]),
  note: z.string().trim().max(2_000).optional(),
}).strict();

export const OPENVIKING_MEMORY_IPC = {
  snapshot: defineIpcRequest("openviking-memory:snapshot", noInput),
  diagnostics: defineIpcRequest("openviking-memory:diagnostics", noInput),
  chooseDirectory: defineIpcRequest("openviking-memory:choose-directory", noInput),
  previewDirectory: defineIpcRequest("openviking-memory:preview-directory", z.tuple([pathInput])),
  addWorkspace: defineIpcRequest("openviking-memory:add-workspace", z.tuple([pathInput])),
  search: defineIpcRequest(
    "openviking-memory:search",
    z.tuple([workspaceIdInput, queryInput, z.number().int().min(1).max(200).optional()]),
  ),
  read: defineIpcRequest("openviking-memory:read", z.tuple([workspaceIdInput, memoryUriInput])),
  readCommitChanges: defineIpcRequest(
    "openviking-memory:read-commit-changes",
    z.tuple([workspaceIdInput, sessionArtifactUriInput]),
  ),
  details: defineIpcRequest("openviking-memory:details", z.tuple([workspaceIdInput, memoryUriInput])),
  save: defineIpcRequest("openviking-memory:save", z.tuple([workspaceIdInput, memoryInput])),
  feedback: defineIpcRequest(
    "openviking-memory:feedback",
    z.tuple([workspaceIdInput, memoryUriInput, feedbackInput]),
  ),
  deleteMemory: defineIpcRequest(
    "openviking-memory:delete-memory",
    z.tuple([workspaceIdInput, memoryUriInput]),
  ),
  stopManaging: defineIpcRequest("openviking-memory:stop-managing", z.tuple([workspaceIdInput])),
  deleteWorkspace: defineIpcRequest("openviking-memory:delete-workspace", z.tuple([workspaceIdInput])),
  installRuntime: defineIpcRequest("openviking-memory:install-runtime", noInput),
  startRuntime: defineIpcRequest("openviking-memory:start-runtime", noInput),
  restartRuntime: defineIpcRequest("openviking-memory:restart-runtime", noInput),
  stopRuntime: defineIpcRequest("openviking-memory:stop-runtime", noInput),
  installModel: defineIpcRequest(
    "openviking-memory:install-model",
    z.tuple([z.literal("BAAI/bge-small-zh-v1.5")]),
  ),
} as const;
