import { z } from "zod";
import { assetId, portableAssetPath, MAX_FILE_BYTES } from "./asset-paths.js";

const roleName = z.string().trim().min(1).max(200).refine((value) => !/[\r\n\0]/.test(value) && !value.includes("agentrecall:team"));
const unique = (items: string[]) => new Set(items).size === items.length;

/**
 * A role stores the runtime and model family it was written for, never a
 * channel, endpoint or credential. Each member maps it to a local channel when
 * enabling the role, so the team repository stays free of personal accounts.
 */
export const agentRoleModelSchema = z.strictObject({
  runtime: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  family: z.string().trim().min(1).max(128).refine((value) => !/[\r\n\0]/.test(value)).optional(),
  reasoningEffort: z.string().regex(/^[a-z]{1,16}$/).optional(),
});
const roleFields = {
  id: assetId,
  name: roleName,
  description: z.string().trim().min(1).max(4096),
  model: agentRoleModelSchema,
  /** Team Skill ids the role is written for; they must exist in the same team snapshot. */
  skills: z.array(assetId).max(64).refine(unique),
  /** Team MCP server ids plus an optional tool allowlist; omitted tools allow every tool of that server. */
  mcpServers: z.array(z.strictObject({ id: assetId, tools: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)).max(128).refine(unique).optional() })).max(32).refine((items) => unique(items.map((item) => item.id))),
  tags: z.array(z.string().trim().min(1).max(64)).max(16).refine((tags) => unique(tags.map((tag) => tag.toLowerCase()))),
};
const instructionsContent = z.string().min(1).refine((value) => {
  const bytes = new TextEncoder().encode(value);
  return bytes.length <= MAX_FILE_BYTES && !value.includes("agentrecall:team") && new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) === value;
});
export const agentRoleEntrySchema = z.strictObject({ ...roleFields, path: z.string().refine(portableAssetPath).refine((value) => value.endsWith(".md")) });
export const agentRoleSchema = agentRoleEntrySchema.extend({ content: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const agentRoleChangeSchema = z.strictObject({ kind: z.literal("agentRoles"), operation: z.enum(["create", "update"]), value: z.strictObject({ ...roleFields, content: instructionsContent }) });
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type AgentRoleChange = z.infer<typeof agentRoleChangeSchema>;
