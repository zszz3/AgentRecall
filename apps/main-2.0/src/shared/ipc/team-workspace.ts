import { z } from "zod";
import type { WorkspaceConfig, TeamAssetService } from "@agentrecall/workspace-core";
import { defineIpcRequest } from "./contract";

const id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/);
const text = z.string().trim().min(1).max(200);
const directory = z.string().min(1).max(32768).refine((value) => !value.includes("\0"));
const repository = z.string().min(1).max(2048);
const target = z.enum(["codex", "claude"]);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const scope = z.object({ projectId: id, root: directory, repository: repository.optional() }).strict();
const selectedScope = scope.extend({ repository });
const asset = { scope, id, target };
const selectedAsset = { scope: selectedScope, id, target };

export const teamRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("snapshot") }).strict(),
  z.object({ action: z.literal("choose-folder") }).strict(),
  z.object({ action: z.literal("enable"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("add-team"), id: id.optional(), name: text.optional(), repository, makeDefault: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("default-team"), id: id.nullable() }).strict(),
  z.object({ action: z.literal("add-project"), id: id.optional(), name: text.optional(), directory, remote: text.optional(), teamId: id.nullable().optional() }).strict(),
  z.object({ action: z.literal("bind-project"), id, root: directory, teamId: id.nullable().optional() }).strict(),
  z.object({ action: z.literal("remove-project"), id, root: directory }).strict(),
  z.object({ action: z.literal("catalog"), scope }).strict(),
  z.object({ action: z.literal("sync"), scope: selectedScope, transport: z.enum(["https", "ssh"]) }).strict(),
  z.object({ action: z.literal("cancel-sync") }).strict(),
  z.object({ action: z.literal("skill-preview"), ...asset, file: z.string().min(1).max(180).optional() }).strict(),
  z.object({ action: z.literal("skill-install"), ...selectedAsset, revision }).strict(),
  z.object({ action: z.literal("work-preview"), ...asset }).strict(),
  z.object({ action: z.literal("work-install"), ...selectedAsset, revision }).strict(),
  z.object({ action: z.literal("work-status"), ...asset }).strict(),
  z.object({ action: z.literal("work-diff"), ...asset }).strict(),
  z.object({ action: z.literal("work-update"), ...selectedAsset, fromRevision: revision, revision }).strict(),
  z.object({ action: z.literal("work-uninstall"), ...selectedAsset, revision }).strict(),
]);
export type TeamRequest = z.infer<typeof teamRequestSchema>;
type Result<M extends keyof TeamAssetService> = TeamAssetService[M] extends (...args: never[]) => infer R ? Awaited<R> : never;
export type TeamSnapshot = { config: WorkspaceConfig | null; busy: boolean };
export type TeamCatalog = {
  projectId: string; root: string;
  assets: Result<"list"> | null;
  installed: Result<"installedWorkConfigs">;
  notice: string | null;
};
export type TeamPayload =
  | { kind: "snapshot"; value: TeamSnapshot }
  | { kind: "folder"; value: string | null }
  | { kind: "catalog"; value: TeamCatalog }
  | { kind: "skill-preview"; value: Result<"preview"> }
  | { kind: "work-preview"; value: Result<"previewWorkConfig"> }
  | { kind: "work-status"; value: Result<"workConfigStatus"> }
  | { kind: "work-diff"; value: Result<"diffWorkConfig"> }
  | { kind: "complete"; message: string; backups: string[] }
  | { kind: "cancelled" };
export type TeamReply = { ok: true; data: TeamPayload } | { ok: false; error: { code: string; message: string; details?: Readonly<Record<string, unknown>> } };
export const TEAM_WORKSPACE_IPC = defineIpcRequest("team-workspace:request", z.tuple([teamRequestSchema]));
