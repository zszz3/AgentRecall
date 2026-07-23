import { z } from "zod";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const ruleIdentityInput = z.string().trim().min(1).max(1024);

export const RULES_IPC = {
  getSyncSnapshot: defineIpcRequest("rules:sync-snapshot", noInput),
  upload: defineIpcRequest("rules:sync-upload", z.tuple([ruleIdentityInput])),
  uploadAll: defineIpcRequest("rules:sync-upload-all", noInput),
  deleteRemote: defineIpcRequest("rules:sync-delete", z.tuple([ruleIdentityInput])),
  copySetupSql: defineIpcRequest("rules:sync-copy-setup-sql", noInput),
  restoreGlobal: defineIpcRequest("rules:sync-restore-global", noInput),
} as const;
