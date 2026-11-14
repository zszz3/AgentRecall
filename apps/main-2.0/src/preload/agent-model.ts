import type { IpcRenderer } from "electron";
import type {
  AgentModelConfig,
  AgentModelImports,
  AgentModelKeyInput,
  AgentModelProviderOption,
} from "../core/agent-model-config";
import { AGENT_MODEL_IPC, type AgentModelTestResult } from "../shared/ipc/agent-model";

export function createAgentModelApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    listAgentModelProviders: (): Promise<AgentModelProviderOption[]> => ipc.invoke(AGENT_MODEL_IPC.listProviders.channel),
    listAgentModelImports: (): Promise<AgentModelImports> => ipc.invoke(AGENT_MODEL_IPC.listImports.channel),
    hasAgentModelKey: (providerId: string): Promise<boolean> => ipc.invoke(AGENT_MODEL_IPC.hasKey.channel, providerId),
    saveAgentModelKey: (config: AgentModelConfig, key: AgentModelKeyInput): Promise<void> =>
      ipc.invoke(AGENT_MODEL_IPC.saveKey.channel, config, key),
    testAgentModel: (config: AgentModelConfig, key: AgentModelKeyInput | null): Promise<AgentModelTestResult> =>
      ipc.invoke(AGENT_MODEL_IPC.test.channel, config, key),
  };
}
