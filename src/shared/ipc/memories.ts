import { z } from "zod";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const memoryIdentityInput = z.string().trim().min(1).max(1024);

export const MEMORIES_IPC = {
  getSyncSnapshot: defineIpcRequest("memories:sync-snapshot", noInput),
  upload: defineIpcRequest("memories:sync-upload", z.tuple([memoryIdentityInput])),
  uploadAll: defineIpcRequest("memories:sync-upload-all", noInput),
  deleteRemote: defineIpcRequest("memories:sync-delete", z.tuple([memoryIdentityInput])),
  copySetupSql: defineIpcRequest("memories:sync-copy-setup-sql", noInput),
} as const;
