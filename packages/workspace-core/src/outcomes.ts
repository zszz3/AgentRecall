import { z } from "zod";
import { assetId, portableAssetPath, MAX_FILE_BYTES } from "./asset-paths.js";

const line = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\r\n\0]/.test(value) && !value.includes("agentrecall:team"));
const unique = (items: string[]) => new Set(items).size === items.length;

/**
 * Where an outcome came from. Workflow runs and sessions stay on the member's
 * machine; only their names travel so readers know what produced the record.
 */
const outcomeSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workflow-run"), workflow: line(200), templateId: assetId.optional() }),
  z.strictObject({ kind: z.literal("manual") }),
]);
const outcomeFields = {
  id: assetId,
  name: line(200),
  summary: z.string().trim().max(4096),
  source: outcomeSourceSchema,
  /**
   * Shared sessions that hold the full transcript. Sessions are published as
   * release attachments by session sharing, so the record only keeps their
   * remote ids and titles instead of copying transcripts into Git.
   */
  sessions: z.array(z.strictObject({ id: z.number().int().positive().safe(), title: line(300) })).max(16).refine((items) => unique(items.map((item) => String(item.id)))),
  tags: z.array(z.string().trim().min(1).max(64)).max(16).refine((tags) => unique(tags.map((tag) => tag.toLowerCase()))),
  createdAt: z.number().int().positive().safe(),
};
const recordContent = z.string().min(1).refine((value) => {
  const bytes = new TextEncoder().encode(value);
  return bytes.length <= MAX_FILE_BYTES && !value.includes("agentrecall:team") && new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) === value;
});
export const outcomeEntrySchema = z.strictObject({ ...outcomeFields, path: z.string().refine(portableAssetPath).refine((value) => value.endsWith(".md")) });
export const outcomeSchema = outcomeEntrySchema.extend({ content: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const outcomeChangeSchema = z.strictObject({ kind: z.literal("outcomes"), operation: z.enum(["create", "update"]), value: z.strictObject({ ...outcomeFields, content: recordContent }) });
export type TeamOutcome = z.infer<typeof outcomeSchema>;
export type OutcomeChange = z.infer<typeof outcomeChangeSchema>;
