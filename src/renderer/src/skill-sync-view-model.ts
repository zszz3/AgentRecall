import type { InstalledSkill, InstalledSkillsSnapshot, SkillSource } from "../../core/skill-manager";
import type { RemoteSkillGroup, SkillSyncRelation, SkillSyncSnapshot, SkillSyncState } from "../../core/skill-sync";

export interface UnifiedSkillEntry {
  id: string;
  identity: string;
  name: string;
  description: string;
  source: SkillSource;
  local: InstalledSkill | null;
  remote: RemoteSkillGroup | null;
  relation: SkillSyncRelation | null;
  state: SkillSyncState | null;
  syncable: boolean;
}

export function buildUnifiedSkillEntries(
  installed: InstalledSkillsSnapshot,
  sync: SkillSyncSnapshot,
): UnifiedSkillEntry[] {
  const localByPath = new Map(installed.skills.map((skill) => [skill.path, skill]));
  const remoteByFingerprint = new Map(sync.remoteSkillGroups.map((group) => [group.fingerprint, group]));
  const usedLocal = new Set<string>();
  const usedRemote = new Set<string>();
  const entries: UnifiedSkillEntry[] = [];

  for (const relation of sync.relations ?? []) {
    const local = relation.localSkillPath ? localByPath.get(relation.localSkillPath) ?? null : null;
    const remote = relation.remoteFingerprint ? remoteByFingerprint.get(relation.remoteFingerprint) ?? null : null;
    if (!local && !remote) continue;
    if (local) usedLocal.add(local.path);
    if (remote) usedRemote.add(remote.fingerprint);
    entries.push(entryFrom(relation.identity, local, remote, relation, relation.state));
  }

  for (const skill of installed.skills) {
    if (usedLocal.has(skill.path)) continue;
    const identity = `local:${skill.id}`;
    entries.push(entryFrom(identity, skill, null, null, null));
  }

  for (const group of sync.remoteSkillGroups) {
    if (usedRemote.has(group.fingerprint)) continue;
    const identity = group.portableScope && group.relativePath
      ? `${group.portableScope}/${group.relativePath}`
      : `legacy:${group.fingerprint}`;
    entries.push(entryFrom(identity, null, group, null, group.legacy ? "legacy" : "remote-only"));
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.identity.localeCompare(b.identity) || a.id.localeCompare(b.id));
}

function entryFrom(
  identity: string,
  local: InstalledSkill | null,
  remote: RemoteSkillGroup | null,
  relation: SkillSyncRelation | null,
  state: SkillSyncState | null,
): UnifiedSkillEntry {
  const source = local?.source ?? remote?.source ?? "codex-user";
  const syncable = Boolean(
    (local && isSyncableSource(local.source)) ||
    (remote && !remote.legacy && isSyncableSource(remote.source)),
  );
  return {
    id: relation ? `sync:${identity}` : local ? `local:${local.id}` : `remote:${remote!.fingerprint}`,
    identity,
    name: local?.name ?? remote?.name ?? identity,
    description: local?.description ?? remote?.description ?? "",
    source,
    local,
    remote,
    relation,
    state,
    syncable,
  };
}

function isSyncableSource(source: SkillSource): boolean {
  return source === "agent-recall" || source === "codex-user" || source === "claude-user" || source === "codex-shared";
}
