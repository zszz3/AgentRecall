import type { ApiConfig, ClaudeApiConfig } from "../../core/api-config";
import type { ApplyClaudeProfileResult } from "../../core/claude-profile";
import type { CodexChatProxyStatus } from "../../core/codex-chat-proxy";
import type { ApplyCodexProfileResult, CodexConfigSnapshot, CodexModelProbeResult } from "../../core/codex-profile";
import { PROVIDERS_IPC, type CodexModelProbeRequest, type ProviderKeyTarget } from "../../shared/ipc/providers";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface ProvidersIpcService {
  getCodexConfig(): Promise<CodexConfigSnapshot>;
  probeCodexModels(input: CodexModelProbeRequest): Promise<CodexModelProbeResult>;
  applyCodexProfile(apiConfig: Partial<ApiConfig>): Promise<ApplyCodexProfileResult>;
  applyClaudeProfile(apiConfig: Partial<ClaudeApiConfig>): Promise<ApplyClaudeProfileResult>;
  getCodexChatProxyStatus(): CodexChatProxyStatus | null;
  stopCodexChatProxy(): Promise<null>;
  getProviderKey(target: ProviderKeyTarget, providerId: string): Promise<string>;
}

export function registerProvidersIpc(ipc: IpcMainRegistrar, service: ProvidersIpcService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, PROVIDERS_IPC.getCodexConfig, () => service.getCodexConfig()),
    registerIpcHandler(ipc, PROVIDERS_IPC.probeCodexModels, (_event, input) => service.probeCodexModels(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.applyCodexProfile, (_event, input) => service.applyCodexProfile(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.applyClaudeProfile, (_event, input) => service.applyClaudeProfile(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.getCodexChatProxyStatus, () => service.getCodexChatProxyStatus()),
    registerIpcHandler(ipc, PROVIDERS_IPC.stopCodexChatProxy, () => service.stopCodexChatProxy()),
    registerIpcHandler(ipc, PROVIDERS_IPC.getApiProviderKey, (_event, target, providerId) =>
      service.getProviderKey(target, providerId)),
  ]);
}
