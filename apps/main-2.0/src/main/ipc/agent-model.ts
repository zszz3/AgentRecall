import type { AgentModelConfig, AgentModelProviderOption } from "../../core/agent-model-config";
import { AGENT_MODEL_IPC, type AgentModelTestResult } from "../../shared/ipc/agent-model";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface AgentModelIpcService {
  listProviders(): AgentModelProviderOption[];
  hasKey(providerId: string): Promise<boolean>;
  saveKey(providerId: string, apiKey: string): Promise<void>;
  test(config: AgentModelConfig, apiKey: string | null): Promise<AgentModelTestResult>;
}

export function registerAgentModelIpc(ipc: IpcMainRegistrar, service: AgentModelIpcService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, AGENT_MODEL_IPC.listProviders, () => service.listProviders()),
    registerIpcHandler(ipc, AGENT_MODEL_IPC.hasKey, (_event, providerId) => service.hasKey(providerId)),
    registerIpcHandler(ipc, AGENT_MODEL_IPC.saveKey, (_event, providerId, apiKey) => service.saveKey(providerId, apiKey)),
    registerIpcHandler(ipc, AGENT_MODEL_IPC.test, (_event, config, apiKey) => service.test(config, apiKey)),
  ]);
}
