import path from "node:path";

import { findAgentMcpServers, type AgentMcpCatalog } from "../../core/agent-mcp-servers";

export interface AgentMcpCatalogDependencies {
  home: string;
  env: Record<string, string | undefined>;
  /** Folders of local projects that have Sessions. */
  localProjects(): Promise<string[]>;
  /** Opens the file in its default app; resolves to an error message, empty on success. */
  openPath(file: string): Promise<string>;
  revealPath(file: string): void;
}

/**
 * Lists the MCP servers configured in the agents on this machine and lets the renderer open
 * only the configuration files that declare them; any other path is refused.
 */
export class AgentMcpCatalogService {
  private listed = new Set<string>();

  constructor(private readonly dependencies: AgentMcpCatalogDependencies) {}

  async list(): Promise<AgentMcpCatalog> {
    const { home, env, localProjects } = this.dependencies;
    const catalog = await findAgentMcpServers({ home, env, projects: await localProjects() });
    this.listed = new Set([
      ...catalog.servers.flatMap((server) => server.locations.map((location) => location.file)),
      ...catalog.problems.map((problem) => problem.file),
    ]);
    return catalog;
  }

  async open(file: string): Promise<void> {
    await this.ensureListed(file);
    const error = await this.dependencies.openPath(file);
    if (error) throw new Error(`Could not open ${path.basename(file)}: ${error}`);
  }

  async reveal(file: string): Promise<void> {
    await this.ensureListed(file);
    this.dependencies.revealPath(file);
  }

  /** The page may ask long after it listed the servers, so look once more before refusing. */
  private async ensureListed(file: string): Promise<void> {
    if (this.listed.has(file)) return;
    await this.list();
    if (!this.listed.has(file)) throw new Error(`${path.basename(file)} is not one of the MCP configuration files any more. Refresh the list and try again.`);
  }
}
