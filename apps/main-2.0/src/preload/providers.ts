import type { IpcRenderer } from "electron";
import type { ApiConfig, ClaudeApiConfig } from "../core/api-config";
import type {
  ApplyClaudeProfileResult,
  ClaudeConfigSnapshot,
  ClaudeModelProbeResult,
} from "../core/claude-profile";
import type { CodexChatProxyStatus } from "../core/codex-chat-proxy";
import type { ApplyCodexProfileResult, CodexConfigSnapshot, CodexModelProbeResult } from "../core/codex-profile";
import {
  PROVIDERS_IPC,
  type ClaudeModelProbeRequest,
  type CodexModelProbeRequest,
  type ConfigSnapshotRequest,
  type ProviderKeyTarget,
  type SummaryProviderConnectionRequest,
  type SummaryProviderConnectionResult,
} from "../shared/ipc/providers";

export type ProvidersIpcRenderer = Pick<IpcRenderer, "invoke">;

export function createProvidersApi(ipc: ProvidersIpcRenderer) {
  return {
    getCodexConfig: (input: ConfigSnapshotRequest = {}): Promise<CodexConfigSnapshot> =>
      ipc.invoke(PROVIDERS_IPC.getCodexConfig.channel, input),
    getClaudeConfig: (input: ConfigSnapshotRequest = {}): Promise<ClaudeConfigSnapshot> =>
      ipc.invoke(PROVIDERS_IPC.getClaudeConfig.channel, input),
    probeCodexModels: (input: CodexModelProbeRequest): Promise<CodexModelProbeResult> =>
      ipc.invoke(PROVIDERS_IPC.probeCodexModels.channel, input),
    probeClaudeModels: (input: ClaudeModelProbeRequest): Promise<ClaudeModelProbeResult> =>
      ipc.invoke(PROVIDERS_IPC.probeClaudeModels.channel, input),
    pickConfigDirectory: (target: ProviderKeyTarget, defaultPath?: string): Promise<string | null> =>
      ipc.invoke(PROVIDERS_IPC.pickConfigDirectory.channel, target, defaultPath),
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
