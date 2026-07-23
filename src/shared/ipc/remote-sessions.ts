import { z } from "zod";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const identifier = z.string().trim().min(1).max(512);
const sessionKey = z.string().min(1).max(32_768).refine((value) => !value.includes("\0"), "Session key must not contain NUL.");
const projectPath = z.string().min(1).max(32_768).refine((value) => !value.includes("\0"), "Project path must not contain NUL.");
const migrationAgent = z.enum(["claude", "codex", "codebuddy", "codewiz", "cursor"]);
const identifierList = z.array(identifier).max(500);
const optionalQuery = z
  .union([z.tuple([]), z.tuple([z.string().max(2_000).optional()])])
  .transform((input): [string] => [input[0] ?? ""]);
const uploadInput = z
  .union([z.tuple([sessionKey]), z.tuple([sessionKey, z.boolean().optional()])])
  .transform((input): [string, boolean] => [input[0], input[1] ?? false]);
const attachmentPreviewInput = z.tuple([
  z.string().regex(/^sessions\/[a-f0-9]{32}\//).max(2_048),
  z.string().regex(/^[a-f0-9]{64}$/),
  z.string().min(1).max(200),
  z.enum(["image", "pdf", "text", "file"]),
]);

export const REMOTE_SESSIONS_IPC = {
  getStatus: defineIpcRequest("remote-session:status", noInput),
  copySetupSql: defineIpcRequest("remote-session:copy-setup-sql", noInput),
  getHookStatus: defineIpcRequest("remote-session:hook-status", noInput),
  installHooks: defineIpcRequest("remote-session:install-hooks", noInput),
  uninstallHooks: defineIpcRequest("remote-session:uninstall-hooks", noInput),
  upload: defineIpcRequest("remote-session:upload", uploadInput),
  list: defineIpcRequest("remote-session:list", optionalQuery),
  listSyncItems: defineIpcRequest("remote-session:sync-items", noInput),
  getDetail: defineIpcRequest("remote-session:detail", z.tuple([identifier])),
  previewAttachment: defineIpcRequest("remote-session:preview-attachment", attachmentPreviewInput),
  chooseProject: defineIpcRequest("remote-session:choose-project", noInput),
  restore: defineIpcRequest("remote-session:restore", z.tuple([identifier, migrationAgent, projectPath])),
  restoreToSource: defineIpcRequest("remote-session:restore-to-source-environment", z.tuple([identifier, migrationAgent])),
  delete: defineIpcRequest("remote-session:delete", z.tuple([identifier])),
  deleteMany: defineIpcRequest("remote-session:delete-many", z.tuple([identifierList])),
} as const;
