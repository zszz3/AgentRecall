import type { ApiConfig, ClaudeApiConfig } from "../../core/api-config";
import type {
  ApplyClaudeProfileResult,
  ClaudeConfigSnapshot,
  ClaudeModelProbeResult,
} from "../../core/claude-profile";
import type { CodexChatProxyStatus } from "../../core/codex-chat-proxy";
import type { ApplyCodexProfileResult, CodexConfigSnapshot, CodexModelProbeResult } from "../../core/codex-profile";
import {
  PROVIDERS_IPC,
  type SavedProvider,
  type ClaudeModelProbeRequest,
  type CodexModelProbeRequest,
  type ConfigSnapshotRequest,
  type ProviderConnectionRequest,
  type ProviderConnectionResult,
  type ProviderKeyTarget,
  type SummaryProviderConnectionRequest,
  type SummaryProviderConnectionResult,
} from "../../shared/ipc/providers";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface ProvidersIpcService {
  listSavedProviders(): Promise<SavedProvider[]>;
  readSavedProvider(id: string): Promise<SavedProvider>;
  saveProvider(provider: SavedProvider): Promise<SavedProvider[]>;
  removeSavedProvider(id: string): Promise<SavedProvider[]>;
  getCodexConfig(input: ConfigSnapshotRequest): Promise<CodexConfigSnapshot>;
  getClaudeConfig(input: ConfigSnapshotRequest): Promise<ClaudeConfigSnapshot>;
  probeCodexModels(input: CodexModelProbeRequest): Promise<CodexModelProbeResult>;
  probeClaudeModels(input: ClaudeModelProbeRequest): Promise<ClaudeModelProbeResult>;
  testProviderConnection(input: ProviderConnectionRequest): Promise<ProviderConnectionResult>;
  testSummaryProviderConnection(
    input: SummaryProviderConnectionRequest,
  ): Promise<SummaryProviderConnectionResult>;
  applyCodexProfile(apiConfig: Partial<ApiConfig>): Promise<ApplyCodexProfileResult>;
  applyClaudeProfile(apiConfig: Partial<ClaudeApiConfig>): Promise<ApplyClaudeProfileResult>;
  getCodexChatProxyStatus(): CodexChatProxyStatus | null;
  stopCodexChatProxy(): Promise<null>;
  getProviderKey(target: ProviderKeyTarget, providerId: string): Promise<string>;
}

export type ProviderConfigDirectoryPicker = (
  target: ProviderKeyTarget,
  defaultPath?: string,
) => Promise<string | null>;

export function registerProvidersIpc(
  ipc: IpcMainRegistrar,
  service: ProvidersIpcService,
  pickConfigDirectory?: ProviderConfigDirectoryPicker,
): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, PROVIDERS_IPC.listSavedProviders, () => service.listSavedProviders()),
    registerIpcHandler(ipc, PROVIDERS_IPC.readSavedProvider, (_event, id) => service.readSavedProvider(id)),
    registerIpcHandler(ipc, PROVIDERS_IPC.saveProvider, (_event, provider) => service.saveProvider(provider)),
    registerIpcHandler(ipc, PROVIDERS_IPC.removeSavedProvider, (_event, id) => service.removeSavedProvider(id)),
    registerIpcHandler(ipc, PROVIDERS_IPC.getCodexConfig, (_event, input) => service.getCodexConfig(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.getClaudeConfig, (_event, input) => service.getClaudeConfig(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.probeCodexModels, (_event, input) => service.probeCodexModels(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.probeClaudeModels, (_event, input) => service.probeClaudeModels(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.testProviderConnection, (_event, input) =>
      service.testProviderConnection(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.pickConfigDirectory, (_event, target, defaultPath) => {
      if (!pickConfigDirectory) throw new Error("Config directory picker is unavailable.");
      return pickConfigDirectory(target, defaultPath);
    }),
    registerIpcHandler(ipc, PROVIDERS_IPC.testSummaryProviderConnection, (_event, input) =>
      service.testSummaryProviderConnection(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.applyCodexProfile, (_event, input) => service.applyCodexProfile(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.applyClaudeProfile, (_event, input) => service.applyClaudeProfile(input)),
    registerIpcHandler(ipc, PROVIDERS_IPC.getCodexChatProxyStatus, () => service.getCodexChatProxyStatus()),
    registerIpcHandler(ipc, PROVIDERS_IPC.stopCodexChatProxy, () => service.stopCodexChatProxy()),
    registerIpcHandler(ipc, PROVIDERS_IPC.getApiProviderKey, (_event, target, providerId) =>
      service.getProviderKey(target, providerId)),
  ]);
}
