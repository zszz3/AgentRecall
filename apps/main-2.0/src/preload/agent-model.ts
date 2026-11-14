import type { IpcRenderer } from "electron";
import type { AgentModelConfig, AgentModelProviderOption } from "../core/agent-model-config";
import { AGENT_MODEL_IPC, type AgentModelTestResult } from "../shared/ipc/agent-model";

export function createAgentModelApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    listAgentModelProviders: (): Promise<AgentModelProviderOption[]> => ipc.invoke(AGENT_MODEL_IPC.listProviders.channel),
    hasAgentModelKey: (providerId: string): Promise<boolean> => ipc.invoke(AGENT_MODEL_IPC.hasKey.channel, providerId),
    saveAgentModelKey: (providerId: string, apiKey: string): Promise<void> =>
      ipc.invoke(AGENT_MODEL_IPC.saveKey.channel, providerId, apiKey),
    testAgentModel: (config: AgentModelConfig, apiKey: string | null): Promise<AgentModelTestResult> =>
      ipc.invoke(AGENT_MODEL_IPC.test.channel, config, apiKey),
  };
}
