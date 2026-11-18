import type {
  AgentModelConfig,
  AgentModelImports,
  AgentModelKeyInput,
  AgentModelProviderOption,
} from "../../core/agent-model-config";
import { AGENT_MODEL_IPC, type AgentModelTestResult } from "../../shared/ipc/agent-model";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface AgentModelIpcService {
  listProviders(): AgentModelProviderOption[];
  listImports(): Promise<AgentModelImports>;
  hasKey(providerId: string): Promise<boolean>;
  saveKey(config: AgentModelConfig, key: AgentModelKeyInput): Promise<void>;
  test(config: AgentModelConfig, key: AgentModelKeyInput | null): Promise<AgentModelTestResult>;
}

export function registerAgentModelIpc(ipc: IpcMainRegistrar, service: AgentModelIpcService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, AGENT_MODEL_IPC.listProviders, () => service.listProviders()),
    registerIpcHandler(ipc, AGENT_MODEL_IPC.listImports, () => service.listImports()),
    registerIpcHandler(ipc, AGENT_MODEL_IPC.hasKey, (_event, providerId) => service.hasKey(providerId)),
    registerIpcHandler(ipc, AGENT_MODEL_IPC.saveKey, (_event, config, key) => service.saveKey(config, key)),
    registerIpcHandler(ipc, AGENT_MODEL_IPC.test, (_event, config, key) => service.test(config, key)),
  ]);
}
