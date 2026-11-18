import { completeWithAgentModel, listAgentModelProviders, type AgentModelReply } from "../../core/agent-model";
import {
  AGENT_MODEL_CUSTOM_PROVIDER,
  AgentModelNotReadyError,
  normalizeAgentModelConfig,
  sameAgentModelEndpoint,
  type AgentModelConfig,
  type AgentModelImports,
  type AgentModelKeyInput,
  type AgentModelProviderOption,
} from "../../core/agent-model-config";
import type { ScannedAgentModelImport, ScannedAgentModelImports } from "../../core/agent-model-imports";
import type { AgentModelTestResult } from "../../shared/ipc/agent-model";
import type { AgentModelIpcService } from "../ipc/agent-model";

/** Bounds one background call, so an endpoint that never answers cannot hold extraction forever. */
const CALL_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 30_000;

export interface AgentModelServiceDependencies {
  config: () => AgentModelConfig;
  /** API keys of the AgentRecall model, one per provider id. */
  keys: {
    get(providerId: string): Promise<string>;
    set(providerId: string, apiKey: string): Promise<void>;
  };
  /** Finds the model services other local agents are set up with. */
  scanImports: () => Promise<ScannedAgentModelImports>;
}

/** Calls the model the user chose for AgentRecall's own tasks with the key saved for its provider. */
export class AgentModelService implements AgentModelIpcService {
  /** Services of the latest scan. The renderer names them by id, so their keys stay in this process. */
  private imports = new Map<string, ScannedAgentModelImport>();

  constructor(private readonly dependencies: AgentModelServiceDependencies) {}

  listProviders(): AgentModelProviderOption[] {
    return listAgentModelProviders();
  }

  async listImports(): Promise<AgentModelImports> {
    const scanned = await this.dependencies.scanImports();
    this.imports = new Map(scanned.imports.map((item) => [item.service.id, item]));
    return { imports: scanned.imports.map((item) => item.service), problems: scanned.problems };
  }

  async hasKey(providerId: string): Promise<boolean> {
    return Boolean(await this.dependencies.keys.get(providerId));
  }

  /** Saves the key under the draft's provider; an imported key is copied, so later changes in the other agent do not follow. */
  async saveKey(draft: AgentModelConfig, key: AgentModelKeyInput): Promise<void> {
    const config = normalizeAgentModelConfig(draft);
    if (!config.provider) throw new Error("Choose a provider before saving its API key.");
    const apiKey = this.keyFrom(config, key);
    if (!apiKey) throw new Error("Enter an API key.");
    await this.dependencies.keys.set(config.provider, apiKey);
  }

  /**
   * Rejects with `AgentModelNotReadyError` until a model is chosen and, for a
   * listed provider, its API key is saved. A custom endpoint may need no key.
   */
  async complete(prompt: string, signal?: AbortSignal): Promise<AgentModelReply> {
    const config = this.dependencies.config();
    const apiKey = config.provider ? await this.dependencies.keys.get(config.provider) : "";
    if (config.provider && config.provider !== AGENT_MODEL_CUSTOM_PROVIDER && !apiKey) {
      throw new AgentModelNotReadyError("Save the API key of the AgentRecall model in Provider → AgentRecall model.");
    }
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    return completeWithAgentModel(config, apiKey, prompt, signal ? AbortSignal.any([signal, timeout]) : timeout);
  }

  /** Tests an unsaved choice; without a key it uses the key saved for the draft's provider. */
  async test(draft: AgentModelConfig, key: AgentModelKeyInput | null): Promise<AgentModelTestResult> {
    const config = normalizeAgentModelConfig(draft);
    const apiKey = key ? this.keyFrom(config, key) : config.provider ? await this.dependencies.keys.get(config.provider) : "";
    const reply = await completeWithAgentModel(config, apiKey, "Reply with the single word OK.", AbortSignal.timeout(TEST_TIMEOUT_MS));
    return { model: reply.model, reply: reply.text };
  }

  /** An imported key goes only to an endpoint of the service it was found with. */
  private keyFrom(config: AgentModelConfig, key: AgentModelKeyInput): string {
    if ("apiKey" in key) return key.apiKey.trim();
    const imported = this.imports.get(key.importId);
    if (!imported) throw new Error("The imported service is no longer available. Choose it again.");
    if (!imported.service.choices.some((choice) => sameAgentModelEndpoint(choice.config, config))) {
      throw new Error(`The key imported for ${imported.service.name} cannot be used with this endpoint. Choose the service again.`);
    }
    return imported.apiKey;
  }
}
