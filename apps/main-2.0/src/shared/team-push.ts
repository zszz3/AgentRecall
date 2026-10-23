import { z } from "zod";
import { configurationChangeSchema } from "../../../../packages/workspace-core/src/configuration-format";
import type { ConfigurationPreview } from "@agentrecall/workspace-core";
import type { TeamSessionContent } from "./team-sessions";
import { folderChangeSchema } from "../../../../packages/workspace-core/src/resource-folders";
import { agentRoleChangeSchema } from "../../../../packages/workspace-core/src/agent-roles";
import { workflowTemplateChangeSchema } from "../../../../packages/workspace-core/src/workflow-templates";
import { outcomeChangeSchema } from "../../../../packages/workspace-core/src/outcomes";
const key = z.string().min(1).max(4096);
const id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const teamPushItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local-resource"), key }).strict(),
  z.object({ kind: z.literal("local-session"), key, id: z.number().int().safe().negative() }).strict(),
  z.object({ kind: z.literal("resource"), key, resource: z.enum(["skills", "documents"]), connectionId: id, directory: key, file: key, id, name: z.string().min(1).max(200), destination: z.string().max(180).optional() }).strict(),
  z.object({ kind: z.literal("session"), key, sessionKey: key }).strict(),
  z.object({ kind: z.literal("turn"), key, sessionKey: key, turnId: key }).strict(),
  z.object({ kind: z.literal("configuration"), key, change: z.union([configurationChangeSchema, folderChangeSchema, agentRoleChangeSchema, workflowTemplateChangeSchema, outcomeChangeSchema]) }).strict(),
]);
export type TeamPushItem = z.infer<typeof teamPushItemSchema>;
export type TeamPushDraft = { teamId?: string; item: TeamPushItem; title: string; subtitle: string };
export interface TeamPushPreview {
  token: string; expiresAt: number; repository: string;
  /** `owners` lists who must approve an item that review rules send to a pull request. */
  items: Array<{ key: string; name: string; status: "added" | "modified" | "unchanged"; owners?: string[]; files: ConfigurationPreview["files"]; session?: TeamSessionContent }>;
}
/** `review` means the item was pushed to a review branch; `url` opens the pull request form. */
export interface TeamPushResult { items: Array<{ key: string; status: "published" | "review" | "unchanged" | "failed" | "cancelled"; message?: string; url?: string }>; }
