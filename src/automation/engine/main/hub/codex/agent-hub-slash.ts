import type { AgentChannel, AgentId } from "../../../shared/types";
import { codexAppServerConfigArgs } from "../../channels/model-config";
import { codexEnvironmentForChannel } from "../../agents/codex/codex-env";
import { CodexRpcClient } from "../../agents/codex/codex-rpc";
import {
  codexPluginSummaries,
  codexSlashHelpText,
  formatCodexModelsSummary,
  formatCodexPluginsSummary,
  formatCodexStatusSummary,
  readCodexMcpServers,
  readCodexModels,
  respondToCodexServerRequest,
} from "./agent-hub-codex-app";
import { asOptionalString, asRecord } from "../persisted/agent-hub-persistence";
import type { ChatState } from "../state/agent-hub-state";

export interface ResolvedConfiguredAgentForSlash {
  runtimeAgentId: AgentId;
  channel: AgentChannel;
  modelId: string;
  reasoningEffort?: string;
}

export async function runSlashCommand(input: {
  chat: ChatState;
  prompt: string;
  executable: string;
  workDir: string;
  resolveConfiguredAgent: (
    configuredAgentId: string | undefined,
    modelIdOverride?: string,
    channelIdOverride?: string,
  ) => ResolvedConfiguredAgentForSlash | undefined;
}): Promise<string> {
  const [command = "", ...args] = input.prompt.slice(1).trim().split(/\s+/).filter(Boolean);
  switch (command.toLowerCase()) {
    case "":
    case "help":
    case "h":
    case "?":
      return codexSlashHelpText();
    case "status":
      return slashStatus(input);
    case "model":
    case "models":
      return slashModels(input);
    case "plugin":
    case "plugins":
      return slashPlugins(input, args);
    default:
      return `Unknown command: /${command}\nType /help to see available commands.`;
  }
}

export async function withCodexAppServer<T>(input: {
  chat: ChatState;
  executable: string;
  workDir: string;
  resolved: ResolvedConfiguredAgentForSlash | undefined;
  callback: (client: CodexRpcClient) => Promise<T>;
}): Promise<T> {
  if (!input.resolved || input.resolved.runtimeAgentId !== "codex") {
    throw new Error("Codex app-server requires a Codex configured agent.");
  }
  const client = new CodexRpcClient({
    executable: input.executable,
    cwd: input.workDir,
    extraArgs: codexAppServerConfigArgs(
      input.resolved.channel,
      input.resolved.modelId,
      input.resolved.reasoningEffort,
    ),
    env: codexEnvironmentForChannel(input.resolved.channel),
    onEvent: () => undefined,
    onRequest: (id, method, params) => {
      respondToCodexServerRequest(client, id, method, params);
    },
  });

  await client.start();
  try {
    return await input.callback(client);
  } finally {
    await client.shutdown();
  }
}

async function slashStatus(input: {
  chat: ChatState;
  executable: string;
  workDir: string;
  resolveConfiguredAgent: (
    configuredAgentId: string | undefined,
    modelIdOverride?: string,
    channelIdOverride?: string,
  ) => ResolvedConfiguredAgentForSlash | undefined;
}): Promise<string> {
  const resolved = input.resolveConfiguredAgent(input.chat.configuredAgentId, input.chat.modelId, input.chat.channelId);
  if (resolved?.runtimeAgentId !== "codex") return "Codex app-server status\nThis status command is only available for Codex chats.";

  try {
    return await withCodexAppServer({
      chat: input.chat,
      executable: input.executable,
      workDir: input.workDir,
      resolved,
      callback: async (client) => {
        const configResult = asRecord(await client.request("config/read", { includeLayers: true, cwd: input.workDir })) ?? {};
        const config = asRecord(configResult.config) ?? {};
        const models = await readCodexModels(client);
        const plugins = codexPluginSummaries(await client.request("plugin/list", { cwds: [input.workDir] }));
        const mcpServers = await readCodexMcpServers(client, undefined);
        return formatCodexStatusSummary({ config, models, plugins, mcpServers, workDir: input.workDir });
      },
    });
  } catch (error) {
    return `Codex app-server status\nUnable to read Codex app-server status: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function slashModels(input: {
  chat: ChatState;
  executable: string;
  workDir: string;
  resolveConfiguredAgent: (
    configuredAgentId: string | undefined,
    modelIdOverride?: string,
    channelIdOverride?: string,
  ) => ResolvedConfiguredAgentForSlash | undefined;
}): Promise<string> {
  const resolved = input.resolveConfiguredAgent(input.chat.configuredAgentId, input.chat.modelId, input.chat.channelId);
  if (resolved?.runtimeAgentId !== "codex") return "Codex models\nModel catalog is only available for Codex chats.";

  try {
    return await withCodexAppServer({
      chat: input.chat,
      executable: input.executable,
      workDir: input.workDir,
      resolved,
      callback: async (client) => {
        const configResult = asRecord(await client.request("config/read", { includeLayers: true, cwd: input.workDir })) ?? {};
        const config = asRecord(configResult.config) ?? {};
        const currentModel = asOptionalString(config.model);
        const models = await readCodexModels(client);
        return formatCodexModelsSummary({ currentModel, models });
      },
    });
  } catch (error) {
    return `Codex models\nUnable to read Codex model catalog: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function slashPlugins(
  input: {
    chat: ChatState;
    executable: string;
    workDir: string;
    resolveConfiguredAgent: (
      configuredAgentId: string | undefined,
      modelIdOverride?: string,
      channelIdOverride?: string,
    ) => ResolvedConfiguredAgentForSlash | undefined;
  },
  args: string[],
): Promise<string> {
  if (args.length > 0 && args[0] !== "list") {
    return "Plugins\nOnly /plugins and /plugin list are supported here for now.";
  }
  const resolved = input.resolveConfiguredAgent(input.chat.configuredAgentId, input.chat.modelId, input.chat.channelId);
  if (resolved?.runtimeAgentId !== "codex") return "Plugins\nPlugins are currently Codex-specific in this app.";

  try {
    return await withCodexAppServer({
      chat: input.chat,
      executable: input.executable,
      workDir: input.workDir,
      resolved,
      callback: async (client) => {
        const plugins = codexPluginSummaries(await client.request("plugin/list", { cwds: [input.workDir] }));
        return formatCodexPluginsSummary(plugins);
      },
    });
  } catch (error) {
    return `Codex plugins\nUnable to read Codex plugins: ${error instanceof Error ? error.message : String(error)}`;
  }
}
