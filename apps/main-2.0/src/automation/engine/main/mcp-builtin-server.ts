import type {
  McpServerDefinition,
  McpToolDefinition,
} from "../shared/mcp/types";

/**
 * Persisted runtime state for the built-in session-search MCP server. Stored in
 * app settings rather than the user MCP registry, so user-created servers and
 * the app-managed server stay fully isolated.
 */
export interface McpBuiltinRuntime {
  tools: McpToolDefinition[];
  disabledTools: string[];
  status: McpServerDefinition["status"];
  lastError?: string;
  lastTestedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Dependencies injected from the app shell. `launchConfig` is the fixed launch
 * command used both by `setup-mcp.cjs` (external CLI registration) and by this
 * module, keeping the two in lock-step.
 */
export interface BuiltinSessionSearchDeps {
  isEnabled(): boolean;
  setEnabled(next: boolean): Promise<boolean>;
  launchConfig(): {
    id: string;
    name: string;
    command: string;
    args: string[];
  };
  readRuntime(): McpBuiltinRuntime | undefined;
  writeRuntime(runtime: McpBuiltinRuntime): void;
}

/**
 * Managed-server deps. `testEnv` supplies literal env values used only when
 * testing the connection (the registry env model resolves values as host
 * environment variable names, which does not fit servers that need literal
 * values such as a bridge path or an in-memory token). `hubBindable: false`
 * hides the server from per-Agent hub bindings.
 */
export interface ManagedMcpDeps extends BuiltinSessionSearchDeps {
  testEnv?(): Record<string, string>;
  hubBindable?: boolean;
}

/** Common surface of app-managed servers consumed by McpAutomationModule. */
export interface ManagedMcp {
  isBuiltinId(id: string): boolean;
  resolve(): Promise<McpServerDefinition>;
  saveDraft(server: McpServerDefinition): Promise<McpServerDefinition>;
  recordTest(server: McpServerDefinition, tools: McpToolDefinition[], error?: string): Promise<McpServerDefinition>;
  testEnv(): Record<string, string>;
}

function emptyRuntime(): McpBuiltinRuntime {
  const now = Date.now();
  return { tools: [], disabledTools: [], status: "untested", createdAt: now, updatedAt: now };
}

/**
 * Base for app-managed MCP servers that are synthesized from app settings and a
 * fixed launch config rather than stored in the user `mcp_servers` table.
 * Connection fields are read-only; only enable state and per-tool toggles are
 * editable, mirrored into app settings so the Settings dialog and the MCP page
 * share one source of truth.
 */
export class ManagedMcpServer implements ManagedMcp {
  constructor(protected readonly deps: ManagedMcpDeps) {}

  isBuiltinId(id: string): boolean {
    return id === this.deps.launchConfig().id;
  }

  testEnv(): Record<string, string> {
    return this.deps.testEnv?.() ?? {};
  }

  async resolve(): Promise<McpServerDefinition> {
    const config = this.deps.launchConfig();
    const runtime = this.deps.readRuntime();
    return {
      id: config.id,
      name: config.name,
      transport: "stdio",
      command: config.command,
      args: config.args,
      env: {},
      enabled: this.deps.isEnabled(),
      tools: runtime?.tools ?? [],
      disabledTools: runtime?.disabledTools ?? [],
      status: runtime?.status ?? "untested",
      ...(runtime?.lastError ? { lastError: runtime.lastError } : {}),
      ...(runtime?.lastTestedAt ? { lastTestedAt: runtime.lastTestedAt } : {}),
      createdAt: runtime?.createdAt ?? Date.now(),
      updatedAt: runtime?.updatedAt ?? Date.now(),
      managed: true,
      ...(this.deps.hubBindable === false ? { hubBindable: false } : {}),
    };
  }

  /**
   * Applies the editable subset of a draft for the managed server: enable
   * state (routed to the settings/setup-mcp toggle) and tool catalog. Any
   * connection fields sent by the client are ignored and re-derived.
   */
  async saveDraft(server: McpServerDefinition): Promise<McpServerDefinition> {
    const current = this.deps.isEnabled();
    if (server.enabled !== current) {
      await this.deps.setEnabled(server.enabled);
    }
    const runtime = this.deps.readRuntime() ?? emptyRuntime();
    this.deps.writeRuntime({
      ...runtime,
      tools: server.tools,
      disabledTools: server.disabledTools ?? [],
      updatedAt: Date.now(),
    });
    return this.resolve();
  }

  /**
   * Records a connection-test outcome for the managed server into the runtime
   * cache. Returns the re-resolved entry with the new tool catalog.
   */
  async recordTest(
    server: McpServerDefinition,
    tools: McpToolDefinition[],
    error?: string,
  ): Promise<McpServerDefinition> {
    const runtime = this.deps.readRuntime() ?? emptyRuntime();
    const next: McpBuiltinRuntime = {
      ...runtime,
      tools,
      disabledTools: server.disabledTools ?? runtime.disabledTools,
      status: error ? "error" : "connected",
      lastTestedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (error) next.lastError = error;
    else delete next.lastError;
    this.deps.writeRuntime(next);
    return this.resolve();
  }
}

/**
 * The app-managed AgentRecall session-search MCP server, registered into
 * Claude Code / Codex / CodeBuddy configs and bindable to AgentRecall agents.
 */
export class BuiltinSessionSearchServer extends ManagedMcpServer {
  constructor(deps: BuiltinSessionSearchDeps) {
    super(deps);
  }
}

/**
 * The app-managed AgentRecall workflow MCP server. Enabled state maps to bulk
 * registration into `~/.codex/config.toml` for configured Codex agents. It is
 * not hub-bindable because its launch config needs literal env (bridge path and
 * in-memory token) that do not fit the registry env-as-host-name model.
 */
export class BuiltinWorkflowMcpServer extends ManagedMcpServer {
  constructor(deps: ManagedMcpDeps) {
    super(deps);
  }
}
