import type { SessionTurnDetail } from "../../core/types";
import { teamPushItemSchema, type TeamPushDraft, type TeamPushPreview, type TeamPushResult } from "../team-push";
import { z } from "zod";
import { configurationChangeSchema } from "../../../../../packages/workspace-core/src/configuration-format";
import type { WorkspaceConfig, TeamAssetService, DirectoryConnection, TeamPullReport } from "@agentrecall/workspace-core";
import type { TeamSessionFetchState, TeamSessionPage, TeamSessionSnapshot, TeamSessionTurnsPage, TeamSessionPreview } from "../team-sessions";
import { teamTurnSelectionSchema } from "../team-sessions";
import { defineIpcRequest } from "./contract";

const id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/);
const text = z.string().trim().min(1).max(200);
const directory = z.string().min(1).max(32768).refine((value) => !value.includes("\0"));
const repository = z.string().min(1).max(2048);
const target = z.enum(["codex", "claude"]);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const legacyScope = z.object({ projectId: id, root: directory.nullable(), directory: directory.optional(), repository: repository.optional() }).strict();
const teamScope = z.object({ teamId: id, repository, connectionId: id.optional(), directory: directory.optional() }).strict();
const scope = z.union([legacyScope, teamScope]);
const selectedScope = z.union([legacyScope.extend({ repository }), teamScope]);
export type TeamScope = z.infer<typeof scope>;
const asset = { scope, id, target };
const share = { scope: selectedScope, id: z.number().int().safe().refine(value => value !== 0), digest: z.string().regex(/^[a-f0-9]{64}$/) };
const selectedAsset = { scope: selectedScope, id, target };

export const teamRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("workspace-changes"), scope: teamScope.pick({ teamId: true, repository: true }) }).strict(),
  z.object({ action: z.literal("workspace-stage"), scope: teamScope.pick({ teamId: true, repository: true }), items: z.array(teamPushItemSchema).min(1).max(500) }).strict(),
  z.object({ action: z.literal("snapshot") }).strict(),
  z.object({ action: z.literal("push-inspect"), scope: teamScope.pick({ teamId: true, repository: true }), revision: revision.optional(), item: teamPushItemSchema }).strict(),
  z.object({ action: z.literal("push-preview"), scope: teamScope.pick({ teamId: true, repository: true }), revision: revision.optional(), items: z.array(teamPushItemSchema).min(1).max(64).refine(items => new Set(items.map(item => item.key)).size === items.length) }).strict(),
  z.object({ action: z.literal("push-publish"), scope: teamScope.pick({ teamId: true, repository: true }), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal("push-discard"), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal("configuration-preview"), scope: teamScope.pick({ teamId: true, repository: true }), revision, change: configurationChangeSchema }).strict(),
  z.object({ action: z.literal("configuration-publish"), scope: teamScope.pick({ teamId: true, repository: true }), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal("configuration-discard"), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal("choose-folder") }).strict(),
  z.object({ action: z.literal("enable"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("add-team"), id: id.optional(), name: text.optional(), repository, transport: z.enum(["https", "ssh"]).optional(), makeDefault: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("team-transport"), id, transport: z.enum(["https", "ssh"]) }).strict(),
  z.object({ action: z.literal("sync-status"), scope: teamScope }).strict(),
  z.object({ action: z.literal("default-team"), id: id.nullable() }).strict(),
  z.object({ action: z.literal("connect-directory"), teamId: id, directory, targets: z.array(target).min(1).max(2) }).strict(),
  z.object({ action: z.literal("update-directory"), teamId: id, id, directory, enabled: z.boolean(), targets: z.array(target).min(1).max(2) }).strict(),
  z.object({ action: z.literal("disconnect-directory"), teamId: id, id, directory }).strict(),
  z.object({ action: z.literal("create-project"), name: text, teamId: id }).strict(),
  z.object({ action: z.literal("add-project"), id: id.optional(), name: text.optional(), directory, remote: text.optional(), teamId: id.nullable().optional() }).strict(),
  z.object({ action: z.literal("bind-project"), id, root: directory.nullable(), teamId: id.nullable().optional() }).strict(),
  z.object({ action: z.literal("remove-project"), id, root: directory.nullable() }).strict(),
  z.object({ action: z.literal("catalog"), scope }).strict(),
  z.object({ action: z.literal("local-assets"), scope, kind: z.enum(["skills", "documents"]), file: z.string().min(1).max(2048).optional() }).strict(),
  z.object({ action: z.literal("document-preview"), scope: selectedScope, id }).strict(),
  z.object({ action: z.literal("document-install"), scope: selectedScope, id, revision }).strict(),
  z.object({ action: z.literal("session-status"), scope: selectedScope, items: z.array(z.object({ id: share.id, digest: share.digest }).strict()).max(100) }).strict(),
  z.object({ action: z.literal("session-fetch"), ...share }).strict(),
  z.object({ action: z.literal("session-fetch-cancel"), ...share }).strict(),
  z.object({ action: z.literal("session-open"), ...share }).strict(),
  z.object({ action: z.literal("session-turns"), ...share, record: z.number().int().min(0).max(127), offset: z.number().int().min(0).max(200000) }).strict(),
  z.object({ action: z.literal("session-export"), ...share, format: z.enum(["markdown", "json"]) }).strict(),
  z.object({ action: z.literal("session-turn"), ...share, record: z.number().int().min(0).max(127), turnId: z.string().min(1).max(1024) }).strict(),
  z.object({ action: z.literal("session-list"), scope: selectedScope, page: z.number().int().min(1).max(100), query: z.string().trim().max(200).optional(), mode: z.enum(["sessions", "turns"]).optional(), includeTools: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("session-preview"), scope: selectedScope, sessionKey: directory, turnIds: teamTurnSelectionSchema.optional() }).strict(),
  z.object({ action: z.literal("session-publish"), scope: selectedScope, token: z.string().uuid() }).strict(),
  ...(["session-download", "session-withdraw"] as const).map((action) => z.object({ action: z.literal(action), scope: selectedScope, id: z.number().int().positive() }).strict()),
  z.object({ action: z.literal("sync"), scope: selectedScope, transport: z.enum(["https", "ssh"]).optional() }).strict(),
  z.object({ action: z.literal("cancel-sync") }).strict(),
  z.object({ action: z.literal("skill-preview"), ...asset, target: target.optional(), file: z.string().min(1).max(180).optional() }).strict(),
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
export type TeamSnapshot = { config: WorkspaceConfig | null; busy: boolean; directories?: DirectoryConnection[] };
export type TeamCatalog = {
  projectId: string; root: string | null;
  assets: Result<"list"> | null;
  installed: Result<"installedWorkConfigs">;
  notice: string | null;
};
export type TeamLocalAsset = { path: string; name: string; bytes: number };
export type TeamLocalCatalog = { directory: string; entries: TeamLocalAsset[]; limited: boolean; skipped: number };
export type TeamPayload =
  | { kind: "workspace-changes"; value: TeamPushDraft[] }
  | { kind: "push-inspection"; value: { item: TeamPushPreview["items"][number]; bytes: number } }
  | { kind: "push-preview"; value: TeamPushPreview }
  | { kind: "push-result"; value: TeamPushResult }
  | { kind: "configuration-preview"; value: Result<"previewConfiguration"> & { token: string; expiresAt: number } }
  | { kind: "configuration-published"; value: Result<"publishConfiguration"> }
  | { kind: "sync-result"; value: TeamPullReport }
  | { kind: "sync-status"; value: TeamPullReport | null }
  | { kind: "local-assets"; value: TeamLocalCatalog }
  | { kind: "local-preview"; value: { path: string; content: string } }
  | { kind: "snapshot"; value: TeamSnapshot }
  | { kind: "folder"; value: string | null }
  | { kind: "document-preview"; value: Result<"previewDocument"> }
  | { kind: "session-list"; value: TeamSessionPage }
  | { kind: "session-preview"; value: TeamSessionPreview }
  | { kind: "session-status"; value: TeamSessionFetchState[] }
  | { kind: "session-fetch"; value: TeamSessionFetchState }
  | { kind: "session-open"; value: TeamSessionSnapshot }
  | { kind: "session-turns"; value: TeamSessionTurnsPage }
  | { kind: "session-turn"; value: SessionTurnDetail | null }
  | { kind: "catalog"; value: TeamCatalog }
  | { kind: "skill-preview"; value: Result<"preview"> }
  | { kind: "work-preview"; value: Result<"previewWorkConfig"> }
  | { kind: "work-status"; value: Result<"workConfigStatus"> }
  | { kind: "work-diff"; value: Result<"diffWorkConfig"> }
  | { kind: "complete"; message: string; backups: string[] }
  | { kind: "cancelled" };
export type TeamReply = { ok: true; data: TeamPayload } | { ok: false; error: { code: string; message: string; details?: Readonly<Record<string, unknown>> } };
export const TEAM_WORKSPACE_IPC = defineIpcRequest("team-workspace:request", z.tuple([teamRequestSchema]));
