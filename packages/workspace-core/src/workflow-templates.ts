import { z } from "zod";
import { assetId, portableAssetPath, MAX_FILE_BYTES } from "./asset-paths.js";

const text = (maximum: number) => z.string().max(maximum).refine((value) => !value.includes("\0"));
const nodeKind = z.enum(["agent", "script", "review", "approval"]);

/**
 * A portable Workflow graph. Agent and review nodes name a team Agent role
 * instead of a local Agent id, so each member runs the template with the Agent
 * they enabled from that role. The remaining node fields belong to the V2
 * Workflow model and are kept as authored; V2 validates them when a member
 * makes a personal copy.
 */
const templateNodeSchema = z.looseObject({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  kind: nodeKind,
  title: text(200),
  role: assetId.optional(),
  runtime: z.string().max(32).optional(),
  source: text(MAX_FILE_BYTES).optional(),
  permissions: z.array(z.string().max(64)).max(16).optional(),
}).superRefine((node, context) => {
  if ("agentId" in node) context.addIssue({ code: "custom", message: "Template nodes reference roles, not local Agents." });
  if ((node.kind === "agent" || node.kind === "review") !== (node.role !== undefined)) context.addIssue({ code: "custom", message: "Agent and review nodes need a role; other nodes have none." });
  if ((node.kind === "script") !== (node.source !== undefined)) context.addIssue({ code: "custom", message: "Only script nodes carry source." });
});
export const workflowTemplateContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  inputs: z.array(z.looseObject({ key: z.string().min(1).max(128) })).max(64),
  nodes: z.array(templateNodeSchema).min(1).max(128).refine((nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length),
});
export type WorkflowTemplateContent = z.infer<typeof workflowTemplateContentSchema>;

const templateFields = {
  id: assetId,
  name: z.string().trim().min(1).max(200).refine((value) => !/[\r\n\0]/.test(value)),
  description: z.string().trim().max(4096),
};
export const workflowTemplateEntrySchema = z.strictObject({ ...templateFields, path: z.string().refine(portableAssetPath).refine((value) => value.endsWith(".json")) });
export const workflowTemplateSchema = workflowTemplateEntrySchema.extend({ content: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const workflowTemplateChangeSchema = z.strictObject({
  kind: z.literal("workflowTemplates"), operation: z.enum(["create", "update"]),
  value: z.strictObject({ ...templateFields, content: z.string().min(1).refine((value) => Buffer.byteLength(value) <= MAX_FILE_BYTES && parseWorkflowTemplate(value) !== null) }),
});
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export type WorkflowTemplateChange = z.infer<typeof workflowTemplateChangeSchema>;

/** Parses template file content; null when it is not a valid portable template. */
export function parseWorkflowTemplate(content: string): WorkflowTemplateContent | null {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; } // Invalid JSON is reported by the caller as an invalid asset.
  const parsed = workflowTemplateContentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Role ids a template needs; each must exist in the same team snapshot. */
export function templateRoles(content: WorkflowTemplateContent): string[] {
  return [...new Set(content.nodes.flatMap((node) => node.role ? [node.role] : []))];
}
