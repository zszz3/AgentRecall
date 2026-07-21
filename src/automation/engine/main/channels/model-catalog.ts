import type { AgentChannel, AgentModelOption } from "../../shared/types";
import { execCli } from "../platform/cli-launcher";
import { parseCodexModelCatalog } from "./model-config";

export type ModelCatalogSource = "codex_cli" | "openai_models";

export interface DiscoveredModelCatalog {
  source: ModelCatalogSource;
  models: AgentModelOption[];
}

export type ModelCatalogDiscoverer = (
  channel: AgentChannel,
  options?: ModelCatalogDiscoveryOptions,
) => Promise<DiscoveredModelCatalog>;

interface ModelCatalogDiscoveryOptions {
  runCodexModels?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  codexCommand?: string;
}

export class ModelCatalogUnsupportedError extends Error {}

function isCodexOfficial(channel: AgentChannel): boolean {
  return channel.agentId === "codex" && (
    channel.modelProvider === "openai" ||
    channel.id === "codex-openai" ||
    channel.id === "codex-official" ||
    channel.presetId === "codex-default"
  );
}

function openAiModelsUrl(channel: AgentChannel): string | undefined {
  if (channel.agentId === "claude" || !channel.baseUrl || channel.isFullUrl || channel.apiFormat === "anthropic" || channel.apiFormat === "gemini_native") return undefined;
  const baseUrl = channel.baseUrl.replace(/\/+$/, "");
  return baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`;
}

function parseOpenAiModelsCatalog(raw: unknown): AgentModelOption[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const entries = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  const models: AgentModelOption[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || models.some((model) => model.id === id)) continue;
    const label = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
    models.push({ id, label });
  }
  return models;
}

export async function discoverChannelModels(
  channel: AgentChannel,
  options: ModelCatalogDiscoveryOptions = {},
): Promise<DiscoveredModelCatalog> {
  if (isCodexOfficial(channel)) {
    const runCodexModels = options.runCodexModels ?? (async () => {
      const result = await execCli({
        executable: options.codexCommand ?? "codex",
        args: ["debug", "models"],
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return result.stdout;
    });
    return { source: "codex_cli", models: parseCodexModelCatalog(await runCodexModels()) };
  }

  const url = openAiModelsUrl(channel);
  if (!url) throw new ModelCatalogUnsupportedError("This provider does not expose an OpenAI-compatible model catalog.");
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: { Accept: "application/json", ...(channel.httpHeaders ?? {}) },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Model catalog request failed with HTTP ${response.status}.`);
  const models = parseOpenAiModelsCatalog(await response.json());
  if (models.length === 0) throw new Error("Provider returned an empty model catalog.");
  return { source: "openai_models", models };
}

export function mergeModelCatalog(current: AgentModelOption[], discovered: AgentModelOption[]): AgentModelOption[] {
  const discoveredById = new Map(discovered.map((model) => [model.id, model]));
  const merged = current.map((model) => {
    const found = discoveredById.get(model.id);
    if (!found) return model;
    discoveredById.delete(model.id);
    return {
      ...found,
      ...model,
      ...(found.reasoningEfforts ? { reasoningEfforts: [...found.reasoningEfforts] } : {}),
      ...(found.defaultReasoningEffort ? { defaultReasoningEffort: found.defaultReasoningEffort } : {}),
    };
  });
  return [...merged, ...discoveredById.values()];
}
