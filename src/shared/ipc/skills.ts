import { z } from "zod";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const pathInput = z.string().min(1).max(32_768).refine((value) => !value.includes("\0"), "Path must not contain NUL.");
const remoteIdInput = z.string().trim().min(1).max(512);
const fingerprintListInput = z.array(z.string().trim().min(1).max(512)).max(500);
const pathListInput = z.array(pathInput).min(1).max(500);
const managedSkillIdInput = z.string().trim().min(1).max(80)
  .regex(/^[a-z0-9._-]+$/)
  .refine((value) => value !== "." && value !== "..", "Invalid managed Skill id.");
const installTargetInput = z.enum(["codex", "claude", "trae"]);
const installTargetsInput = z.array(installTargetInput).max(3);
const discoveryQueryInput = z.object({
  page: z.number().int().min(0).max(10_000),
  query: z.string().max(500).transform((value) => value.trim()),
}).strict();
const discoveredSkillIdInput = z.string().trim().min(1).max(512).refine((value) => {
  if (value.includes("\0") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.length === 3 && segments.every((segment) => segment && segment !== "." && segment !== "..");
}, "Invalid skills.sh Skill id.");
const optionalBooleanInput = z
  .union([z.tuple([pathInput]), z.tuple([pathInput, z.boolean().optional()])])
  .transform((input): [string, boolean] => [input[0], input[1] ?? false]);

export const SKILLS_IPC = {
  list: defineIpcRequest("skills:list", noInput),
  listImportCandidates: defineIpcRequest("skills:import-candidates", noInput),
  importLocal: defineIpcRequest("skills:import-local", z.tuple([pathListInput])),
  updateTargets: defineIpcRequest("skills:update-targets", z.tuple([managedSkillIdInput, installTargetsInput])),
  listDiscovered: defineIpcRequest("skills:discover-list", z.tuple([discoveryQueryInput])),
  getDiscovered: defineIpcRequest("skills:discover-detail", z.tuple([discoveredSkillIdInput])),
  importDiscovered: defineIpcRequest("skills:discover-import", z.tuple([discoveredSkillIdInput])),
  refreshUsage: defineIpcRequest("skills:refresh-usage", noInput),
  getSyncSnapshot: defineIpcRequest("skills:sync-snapshot", noInput),
  upload: defineIpcRequest("skills:sync-upload", optionalBooleanInput),
  install: defineIpcRequest("skills:sync-install", z.tuple([remoteIdInput])),
  downloadMany: defineIpcRequest("skills:sync-download-many", z.tuple([fingerprintListInput])),
  deleteMany: defineIpcRequest("skills:sync-delete-many", z.tuple([fingerprintListInput])),
  getVersion: defineIpcRequest("skills:sync-get-version", z.tuple([remoteIdInput])),
  getDiff: defineIpcRequest("skills:sync-diff", z.tuple([pathInput.nullable(), remoteIdInput.nullable()])),
  copySetupSql: defineIpcRequest("skills:sync-copy-setup-sql", noInput),
  copyPath: defineIpcRequest("skills:copy-path", z.tuple([pathInput])),
  reveal: defineIpcRequest("skills:reveal", z.tuple([pathInput])),
  delete: defineIpcRequest("skills:delete", z.tuple([pathInput])),
  getUsageHookStatus: defineIpcRequest("skills:usage-hook-status", noInput),
  installUsageHook: defineIpcRequest("skills:install-usage-hook", noInput),
  uninstallUsageHook: defineIpcRequest("skills:uninstall-usage-hook", noInput),
} as const;
