import type { CodexPluginCatalogItem } from "../../../shared/types";
import { CodexRpcClient } from "../../agents/codex/codex-rpc";
import { asArray, asBoolean, asOptionalString, asRecord } from "../persisted/agent-hub-persistence";
export function codexSlashHelpText(): string {
  return [
    "Slash commands",
    "/status - read Codex app-server config, model, plugin, and MCP status.",
    "/models - list models from Codex app-server.",
    "/plugins - list Codex plugins from app-server marketplaces.",
    "/help - show this command list.",
  ].join("\n");
}

export async function readCodexModels(client: CodexRpcClient): Promise<unknown[]> {
  const models: unknown[] = [];
  let cursor: string | null = null;
  do {
    const result: Record<string, unknown> = asRecord(await client.request("model/list", { cursor, limit: 200, includeHidden: false })) ?? {};
    models.push(...asArray(result.data));
    cursor = asOptionalString(result.nextCursor) ?? null;
  } while (cursor);
  return models;
}

export async function readCodexMcpServers(client: CodexRpcClient, threadId: string | undefined): Promise<unknown[]> {
  const servers: unknown[] = [];
  let cursor: string | null = null;
  do {
    const result: Record<string, unknown> =
      asRecord(
        await client.request("mcpServerStatus/list", {
          cursor,
          limit: 200,
          detail: "toolsAndAuthOnly",
          threadId: threadId ?? null,
        }),
      ) ?? {};
    servers.push(...asArray(result.data));
    cursor = asOptionalString(result.nextCursor) ?? null;
  } while (cursor);
  return servers;
}

export function codexPluginSummaries(result: unknown): CodexPluginCatalogItem[] {
  const summaries: CodexPluginCatalogItem[] = [];
  const response = asRecord(result) ?? {};
  for (const marketplaceItem of asArray(response.marketplaces)) {
    const marketplace = asRecord(marketplaceItem) ?? {};
    const marketplaceName = asOptionalString(marketplace.name) ?? "unknown";
    for (const pluginItem of asArray(marketplace.plugins)) {
      const plugin = asRecord(pluginItem) ?? {};
      const id = asOptionalString(plugin.id);
      if (!id) continue;
      const summary: CodexPluginCatalogItem = {
        id,
        name: asOptionalString(plugin.name) ?? id,
        marketplace: marketplaceName,
        installed: asBoolean(plugin.installed),
        enabled: asBoolean(plugin.enabled),
      };
      const version = asOptionalString(plugin.localVersion);
      if (version) summary.version = version;
      summaries.push(summary);
    }
  }
  return summaries;
}

export function formatCodexStatusSummary(input: {
  config: Record<string, unknown>;
  models: unknown[];
  plugins: CodexPluginCatalogItem[];
  mcpServers: unknown[];
  workDir: string;
}): string {
  const model = asOptionalString(input.config.model) ?? "default";
  const provider = asOptionalString(input.config.model_provider) ?? "default";
  const approval = asOptionalString(input.config.approval_policy) ?? "default";
  const sandbox = asOptionalString(input.config.sandbox_mode) ?? "default";
  const reasoning = asOptionalString(input.config.model_reasoning_effort) ?? "default";
  const webSearch = asOptionalString(input.config.web_search) ?? "default";
  const enabledPlugins = input.plugins.filter((plugin) => plugin.enabled).length;
  const installedPlugins = input.plugins.filter((plugin) => plugin.installed).length;
  const visibleModels = input.models.filter((modelItem) => !asBoolean(asRecord(modelItem)?.hidden)).length;

  return [
    "Codex app-server status",
    `Model: ${model}`,
    `Provider: ${provider}`,
    `Approval: ${approval}`,
    `Sandbox: ${sandbox}`,
    `Reasoning: ${reasoning}`,
    `Web search: ${webSearch}`,
    `Models: ${visibleModels} visible, ${input.models.length} total`,
    `Plugins: ${input.plugins.length} total, ${enabledPlugins} enabled, ${installedPlugins} installed`,
    `MCP servers: ${input.mcpServers.length}`,
    `CWD: ${input.workDir}`,
  ].join("\n");
}

export function formatCodexModelsSummary(input: {
  currentModel: string | undefined;
  models: unknown[];
}): string {
  const visibleModels = input.models.filter((item) => !asBoolean(asRecord(item)?.hidden));
  const lines = visibleModels.map((item) => {
    const model = asRecord(item) ?? {};
    const id = asOptionalString(model.id) ?? asOptionalString(model.model) ?? "unknown";
    const displayName = asOptionalString(model.displayName) ?? id;
    const marker = id === input.currentModel || model.model === input.currentModel || model.isDefault === true ? "*" : "-";
    return `${marker} ${displayName} (${id})`;
  });
  return ["Codex models", ...lines].join("\n");
}

export function formatCodexPluginsSummary(plugins: CodexPluginCatalogItem[]): string {
  const enabledPlugins = plugins.filter((plugin) => plugin.enabled).length;
  const installedPlugins = plugins.filter((plugin) => plugin.installed).length;
  const grouped = new Map<string, CodexPluginCatalogItem[]>();
  for (const plugin of plugins) {
    const items = grouped.get(plugin.marketplace) ?? [];
    items.push(plugin);
    grouped.set(plugin.marketplace, items);
  }

  const lines = [`Codex plugins`, `${plugins.length} total, ${enabledPlugins} enabled, ${installedPlugins} installed`];
  for (const [marketplace, items] of grouped) {
    lines.push("", `Marketplace: ${marketplace}`);
    for (const plugin of items) {
      const state = plugin.enabled ? "enabled" : plugin.installed ? "installed" : "available";
      lines.push(`- ${plugin.id} [${state}]${plugin.version ? ` ${plugin.version}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function respondToCodexServerRequest(
  client: CodexRpcClient,
  id: number,
  method: string,
  params: Record<string, unknown>,
): void {
  const isWorkflowMcpRequest = ["workflow_create", "workflow_validate", "workflow_context_append"].some((toolName) =>
    JSON.stringify(params).toLowerCase().includes(toolName),
  );
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    client.respond(id, { decision: "accept" });
    return;
  }
  if (method === "item/tool/requestUserInput") {
    client.respond(id, { answers: {} });
    return;
  }
  if (method === "item/mcpToolCall/requestApproval" || method === "mcpServer/toolCall/requestApproval" || method === "mcp/tool/requestApproval") {
    client.respond(id, { decision: isWorkflowMcpRequest ? "accept" : "decline" });
    return;
  }
  if (method === "mcpServer/elicitation/request") {
    client.respond(id, isWorkflowMcpRequest
      ? { action: "accept", content: {}, _meta: null }
      : { action: "decline", content: null, _meta: null });
    return;
  }
  if (method === "item/permissions/requestApproval") {
    client.respond(id, { permissions: params.permissions ?? {}, scope: "turn" });
    return;
  }
  if (method === "item/tool/call" || method === "mcp/dynamicToolCall") {
    client.respond(id, {
      contentItems: [{ type: "inputText", text: "AgentRecall does not handle Codex tool calls in this surface." }],
      success: false,
    });
    return;
  }
  client.respond(id, {});
}
