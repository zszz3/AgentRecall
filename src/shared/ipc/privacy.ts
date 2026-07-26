import { z } from "zod";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const planId = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/);

export const PRIVACY_IPC = {
  diagnostics: defineIpcRequest("privacy:diagnostics", noInput),
  inspectLegacy: defineIpcRequest("privacy:legacy-inspect", noInput),
  previewLegacyCleanup: defineIpcRequest("privacy:legacy-preview", noInput),
  applyLegacyCleanup: defineIpcRequest(
    "privacy:legacy-apply",
    z.tuple([planId, z.literal(true)]),
  ),
} as const;
