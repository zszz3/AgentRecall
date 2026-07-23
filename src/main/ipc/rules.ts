import type { AgentRule, RemoteRule, RestoreResult, RulesSyncSnapshot } from "../../core/rules-sync";
import { RULES_IPC } from "../../shared/ipc/rules";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface RulesIpcService {
  getSyncSnapshot(): Promise<RulesSyncSnapshot>;
  upload(identity: string): Promise<RemoteRule>;
  uploadAll(): Promise<{ uploaded: number; skipped: number }>;
  deleteRemote(remoteId: string): Promise<boolean>;
  copySetupSql(): void;
  restoreGlobal(): Promise<RestoreResult>;
}

export function registerRulesIpc(ipc: IpcMainRegistrar, service: RulesIpcService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, RULES_IPC.getSyncSnapshot, () => service.getSyncSnapshot()),
    registerIpcHandler(ipc, RULES_IPC.upload, (_event, identity) => service.upload(identity)),
    registerIpcHandler(ipc, RULES_IPC.uploadAll, () => service.uploadAll()),
    registerIpcHandler(ipc, RULES_IPC.deleteRemote, (_event, id) => service.deleteRemote(id)),
    registerIpcHandler(ipc, RULES_IPC.copySetupSql, () => service.copySetupSql()),
    registerIpcHandler(ipc, RULES_IPC.restoreGlobal, () => service.restoreGlobal()),
  ]);
}
