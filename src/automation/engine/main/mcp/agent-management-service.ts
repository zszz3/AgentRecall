import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MCP_CATALOG, buildManagedMcpBlock, diagnoseManagedMcpsForAgent, listManagedMcpEntries,
  mcpServerNameForAgent, mergeManagedMcpBlock, removeManagedMcpBlock,
  type McpAgentDiagnostic, type McpInstallRequest, type McpInstallResult, type McpInstalledEntry, type McpSetupStatus,
} from "../../shared/mcp-config";

export class McpAgentManagementService {
  constructor(private readonly dependencies: {
    homeDir: () => string;
    appDataDir: () => string;
    workDir: () => string;
    serverPath: () => string;
    bridgePath: () => string;
    bridgeRunning: () => boolean;
    workflowCreateAvailable: () => boolean;
  }) {}

  status(): McpSetupStatus {
    return { serverPath: this.dependencies.serverPath(), bridgePath: this.dependencies.bridgePath(), configPath: this.configPath(), serverBuilt: existsSync(this.dependencies.serverPath()), bridgeRunning: this.dependencies.bridgeRunning(), workflowCreateAvailable: this.dependencies.workflowCreateAvailable() };
  }

  async listInstalled(): Promise<McpInstalledEntry[]> { return listManagedMcpEntries(await this.readConfig()); }
  async listForAgent(agentId: string): Promise<McpAgentDiagnostic[]> { return diagnoseManagedMcpsForAgent(await this.readConfig(), agentId); }
  install(request: McpInstallRequest): Promise<McpInstallResult> { return this.mutate(request, true); }
  uninstall(request: McpInstallRequest): Promise<McpInstallResult> { return this.mutate(request, false); }

  private async mutate(request: McpInstallRequest, install: boolean): Promise<McpInstallResult> {
    const item = MCP_CATALOG.find((candidate) => candidate.id === request.catalogId);
    if (!item) throw new Error(`Unknown MCP catalog item: ${request.catalogId}`);
    const configPath = this.configPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    const content = await this.readConfig();
    const serverName = mcpServerNameForAgent(request.agentId, item.id);
    let next = removeManagedMcpBlock(content, serverName);
    if (install) {
      const args = item.id === "workflow" ? [this.dependencies.serverPath()] : [...item.defaultArgs, ...(item.requiresPath ? [request.allowedPath || this.dependencies.workDir()] : [])];
      const env: Record<string, string> = item.id === "workflow" ? { AGENT_RECALL_WORKFLOW_MCP_BRIDGE: this.dependencies.bridgePath(), AGENT_RECALL_CONFIGURED_AGENT_ID: request.agentId } : item.requiresToken ? { GITHUB_PERSONAL_ACCESS_TOKEN: request.token ?? "" } : {};
      if (item.requiresToken && !env.GITHUB_PERSONAL_ACCESS_TOKEN) throw new Error("GitHub token is required.");
      next = mergeManagedMcpBlock(content, buildManagedMcpBlock({ serverName, command: item.command, args, env, agentId: request.agentId, catalogId: item.id }));
    }
    const backupPath = existsSync(configPath) ? `${configPath}.backup-${Date.now()}` : undefined;
    if (backupPath) await copyFile(configPath, backupPath);
    const tempPath = `${configPath}.tmp-${process.pid}`;
    await writeFile(tempPath, next, "utf8");
    await rename(tempPath, configPath);
    return { configPath, ...(backupPath ? { backupPath } : {}), serverName, installed: install };
  }

  private configPath(): string { return path.join(this.dependencies.homeDir(), ".codex", "config.toml"); }
  private async readConfig(): Promise<string> { return readFile(this.configPath(), "utf8").catch(() => ""); }
}
