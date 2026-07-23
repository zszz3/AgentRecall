import type { IpcRenderer } from "electron";
import type { RemoteRule, RestoreResult, RulesSyncSnapshot } from "../core/rules-sync";
import { RULES_IPC } from "../shared/ipc/rules";

export type RulesIpcRenderer = Pick<IpcRenderer, "invoke">;

export function createRulesApi(ipc: RulesIpcRenderer) {
  return {
    getRulesSyncSnapshot: (): Promise<RulesSyncSnapshot> => ipc.invoke(RULES_IPC.getSyncSnapshot.channel),
    uploadRuleToSync: (identity: string): Promise<RemoteRule> => ipc.invoke(RULES_IPC.upload.channel, identity),
    uploadAllRulesToSync: (): Promise<{ uploaded: number; skipped: number }> => ipc.invoke(RULES_IPC.uploadAll.channel),
    deleteRemoteRule: (remoteId: string): Promise<boolean> => ipc.invoke(RULES_IPC.deleteRemote.channel, remoteId),
    copyRulesSyncSetupSql: (): Promise<void> => ipc.invoke(RULES_IPC.copySetupSql.channel),
    restoreGlobalRules: (): Promise<RestoreResult> => ipc.invoke(RULES_IPC.restoreGlobal.channel),
  };
}

export type RulesApi = ReturnType<typeof createRulesApi>;
