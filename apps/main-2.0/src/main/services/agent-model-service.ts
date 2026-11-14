import { completeWithAgentModel, listAgentModelProviders, type AgentModelReply } from "../../core/agent-model";
import {
  AGENT_MODEL_CUSTOM_PROVIDER,
  AgentModelNotReadyError,
  normalizeAgentModelConfig,
  type AgentModelConfig,
  type AgentModelProviderOption,
} from "../../core/agent-model-config";
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
}

/** Calls the model the user chose for AgentRecall's own tasks with the key saved for its provider. */
export class AgentModelService implements AgentModelIpcService {
  constructor(private readonly dependencies: AgentModelServiceDependencies) {}

  listProviders(): AgentModelProviderOption[] {
    return listAgentModelProviders();
  }

  async hasKey(providerId: string): Promise<boolean> {
    return Boolean(await this.dependencies.keys.get(providerId));
  }

  saveKey(providerId: string, apiKey: string): Promise<void> {
    return this.dependencies.keys.set(providerId, apiKey);
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

  /** Tests an unsaved choice; a null key uses the key saved for the draft's provider. */
  async test(draft: AgentModelConfig, apiKey: string | null): Promise<AgentModelTestResult> {
    const config = normalizeAgentModelConfig(draft);
    const key = apiKey ?? (config.provider ? await this.dependencies.keys.get(config.provider) : "");
    const reply = await completeWithAgentModel(config, key, "Reply with the single word OK.", AbortSignal.timeout(TEST_TIMEOUT_MS));
    return { model: reply.model, reply: reply.text };
  }
}
