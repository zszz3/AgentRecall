import type { IpcRenderer } from "electron";
import type { ApiConfig, ClaudeApiConfig } from "../core/api-config";
import type { ApplyClaudeProfileResult } from "../core/claude-profile";
import type { CodexChatProxyStatus } from "../core/codex-chat-proxy";
import type { ApplyCodexProfileResult, CodexConfigSnapshot, CodexModelProbeResult } from "../core/codex-profile";
import {
  PROVIDERS_IPC,
  type CodexModelProbeRequest,
  type ProviderKeyTarget,
  type SummaryProviderConnectionRequest,
  type SummaryProviderConnectionResult,
} from "../shared/ipc/providers";

export type ProvidersIpcRenderer = Pick<IpcRenderer, "invoke">;

export function createProvidersApi(ipc: ProvidersIpcRenderer) {
  return {
    getCodexConfig: (): Promise<CodexConfigSnapshot> =>
      ipc.invoke(PROVIDERS_IPC.getCodexConfig.channel),
    probeCodexModels: (input: CodexModelProbeRequest): Promise<CodexModelProbeResult> =>
      ipc.invoke(PROVIDERS_IPC.probeCodexModels.channel, input),
    testSummaryProviderConnection: (
      input: SummaryProviderConnectionRequest,
    ): Promise<SummaryProviderConnectionResult> =>
      ipc.invoke(PROVIDERS_IPC.testSummaryProviderConnection.channel, input),
    applyCodexProfile: (apiConfig: ApiConfig): Promise<ApplyCodexProfileResult> =>
      ipc.invoke(PROVIDERS_IPC.applyCodexProfile.channel, apiConfig),
    getCodexChatProxyStatus: (): Promise<CodexChatProxyStatus | null> =>
      ipc.invoke(PROVIDERS_IPC.getCodexChatProxyStatus.channel),
    stopCodexChatProxy: (): Promise<null> =>
      ipc.invoke(PROVIDERS_IPC.stopCodexChatProxy.channel),
    applyClaudeProfile: (apiConfig: ClaudeApiConfig): Promise<ApplyClaudeProfileResult> =>
      ipc.invoke(PROVIDERS_IPC.applyClaudeProfile.channel, apiConfig),
    getApiProviderKey: (target: ProviderKeyTarget, providerId: string): Promise<string> =>
      ipc.invoke(PROVIDERS_IPC.getApiProviderKey.channel, target, providerId),
  };
}

export type ProvidersApi = ReturnType<typeof createProvidersApi>;
