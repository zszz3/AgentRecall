import type * as acp from "@agentclientprotocol/sdk";
import type { McpServerDefinition } from "../../../../shared/mcp/types";
import type { ClaudeAgentSdkRunInput } from "../../../agents/claude/claude-agent-sdk";
import { workflowMcpLaunchConfig } from "./workflow/workflow-mcp-launch";

export interface BoundMcpServer {
  server: McpServerDefinition;
  toolAllowlist: string[];
}

function runtimeServerName(serverId: string): string {
  return `agent_recall_${Buffer.from(serverId, "utf8").toString("base64url")}`;
}

function resolvedEnvironment(
  server: McpServerDefinition,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(server.env).map(([name, hostName]) => [name, environment[hostName] ?? ""]),
  );
}

export function codexMcpLaunchConfig(
  bindings: BoundMcpServer[],
  environment: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const { server, toolAllowlist } of bindings) {
    const prefix = `mcp_servers.${runtimeServerName(server.id)}`;
    if (server.transport === "stdio" && server.command?.trim()) {
      args.push("-c", `${prefix}.command=${JSON.stringify(server.command.trim())}`);
      args.push("-c", `${prefix}.args=[${server.args.map((arg) => JSON.stringify(arg)).join(", ")}]`);
      const resolved = resolvedEnvironment(server, environment);
      const names = Object.keys(resolved);
      if (names.length > 0) {
        Object.assign(env, resolved);
        args.push("-c", `${prefix}.env_vars=[${names.map((name) => JSON.stringify(name)).join(", ")}]`);
      }
    } else if (server.transport === "http" && server.url?.trim()) {
      args.push("-c", `${prefix}.url=${JSON.stringify(server.url.trim())}`);
    } else {
      continue;
    }
    if (toolAllowlist.length > 0) {
      args.push("-c", `${prefix}.enabled_tools=[${toolAllowlist.map((name) => JSON.stringify(name)).join(", ")}]`);
    }
  }
  return { args, env };
}

export function claudeMcpServers(
  bindings: BoundMcpServer[],
  environment: NodeJS.ProcessEnv = process.env,
): ClaudeAgentSdkRunInput["mcpServers"] | undefined {
  const result: NonNullable<ClaudeAgentSdkRunInput["mcpServers"]> = {};
  for (const { server, toolAllowlist } of bindings) {
    const name = runtimeServerName(server.id);
    const tools = toolAllowlist.length > 0 && server.tools.length > 0
      ? server.tools.map((tool) => ({
          name: tool.name,
          permission_policy: toolAllowlist.includes(tool.name) ? "always_allow" as const : "always_deny" as const,
        }))
      : undefined;
    if (server.transport === "stdio" && server.command?.trim()) {
      result[name] = {
        type: "stdio",
        command: server.command.trim(),
        args: [...server.args],
        env: resolvedEnvironment(server, environment),
        ...(tools ? { tools } : {}),
      };
    } else if (server.transport === "http" && server.url?.trim()) {
      result[name] = {
        type: "http",
        url: server.url.trim(),
        ...(tools ? { tools } : {}),
      };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function acpMcpServers(
  bindings: BoundMcpServer[],
  environment: NodeJS.ProcessEnv = process.env,
): acp.McpServer[] {
  const result: acp.McpServer[] = [];
  for (const { server } of bindings) {
    const name = runtimeServerName(server.id);
    if (server.transport === "stdio" && server.command?.trim()) {
      result.push({
        name,
        command: server.command.trim(),
        args: [...server.args],
        env: Object.entries(resolvedEnvironment(server, environment)).map(([name, value]) => ({ name, value })),
      });
    } else if (server.transport === "http" && server.url?.trim()) {
      result.push({ type: "http", name, url: server.url.trim(), headers: [] });
    }
  }
  return result;
}

export function acpWorkflowMcpServers(discoveryPath: string | undefined, workflowId: string | undefined, runId?: string, nodeId?: string): acp.McpServer[] {
  const config = workflowMcpLaunchConfig(discoveryPath, workflowId, { runId, nodeId });
  return config ? [{ name: "agent_recall_workflow", command: config.command, args: config.args, env: Object.entries(config.env).map(([name, value]) => ({ name, value })) }] : [];
}
