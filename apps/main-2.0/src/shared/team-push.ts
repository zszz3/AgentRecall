import { z } from "zod";
import { configurationChangeSchema } from "../../../../packages/workspace-core/src/configuration-format";
import type { ConfigurationPreview } from "@agentrecall/workspace-core";
import type { TeamSessionContent } from "./team-sessions";
import { folderChangeSchema } from "../../../../packages/workspace-core/src/resource-folders";
const key = z.string().min(1).max(4096);
const id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const teamPushItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local-resource"), key }).strict(),
  z.object({ kind: z.literal("local-session"), key, id: z.number().int().safe().negative() }).strict(),
  z.object({ kind: z.literal("resource"), key, resource: z.enum(["skills", "documents"]), connectionId: id, directory: key, file: key, id, name: z.string().min(1).max(200), destination: z.string().max(180).optional() }).strict(),
  z.object({ kind: z.literal("session"), key, sessionKey: key }).strict(),
  z.object({ kind: z.literal("turn"), key, sessionKey: key, turnId: key }).strict(),
  z.object({ kind: z.literal("configuration"), key, change: z.union([configurationChangeSchema, folderChangeSchema]) }).strict(),
]);
export type TeamPushItem = z.infer<typeof teamPushItemSchema>;
export type TeamPushDraft = { teamId?: string; item: TeamPushItem; title: string; subtitle: string };
export interface TeamPushPreview {
  token: string; expiresAt: number; repository: string;
  items: Array<{ key: string; name: string; status: "added" | "modified" | "unchanged"; files: ConfigurationPreview["files"]; session?: TeamSessionContent }>;
}
export interface TeamPushResult { items: Array<{ key: string; status: "published" | "unchanged" | "failed" | "cancelled"; message?: string }>; }
