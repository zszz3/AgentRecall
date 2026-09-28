import { z } from "zod";

export const MAX_FILE_BYTES = 1024 * 1024;
export const assetId = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).refine((value) => value !== "synced" && portableAssetPath(value));
export const revision = z.string().regex(/^[a-f0-9]{40}$/);
export function portableAssetPath(value: string): boolean {
  return value.length > 0 && value.length <= 180 && value.split("/").every((part) =>
    part !== "." && part !== ".." && !/[. ]$/.test(part) && /^[^<>:"\\|?*\x00-\x1f]+$/.test(part)
    && !/^(?:\.git|\.agentrecall-install\.json|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
