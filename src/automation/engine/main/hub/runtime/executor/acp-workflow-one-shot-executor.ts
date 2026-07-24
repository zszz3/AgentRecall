import type * as acp from "@agentclientprotocol/sdk";
import {
  AcpInteractiveClient,
  type AcpInteractiveClientOptions,
} from "../../../agents/acp/acp-interactive-client";
import type { AgentExecutionContext, AgentExecutor } from "./agent-executor-types";
import { promptWithDeveloperInstructions } from "./runtime-instructions";
import { workflowMcpScopeForContext } from "../../../../shared/workflow-mcp-policy";

interface AcpOneShotClient {
  attach(): Promise<string>;
  prompt(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  detach(): Promise<void>;
}

interface AcpWorkflowOneShotOptions {
  executable: string;
  args: string[];
  mcpServers: acp.McpServer[];
  modelId?: string;
  requestApproval?: AcpInteractiveClientOptions["requestApproval"];
  createClient?: (options: AcpInteractiveClientOptions) => AcpOneShotClient;
}

export class AcpWorkflowOneShotExecutor implements AgentExecutor {
  private client: AcpOneShotClient | undefined;
  private detachPromise: Promise<unknown | undefined> | undefined;

  constructor(
    private readonly context: AgentExecutionContext,
    private readonly options: AcpWorkflowOneShotOptions,
  ) {}

  async start(): Promise<void> {
    const createClient = this.options.createClient ?? ((options) => new AcpInteractiveClient(options));
    const client = createClient({
      executable: this.options.executable,
      args: this.options.args,
      cwd: this.context.workDir,
      ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
      mcpServers: this.options.mcpServers,
      onEvent: this.context.emit,
      approvalOwnerId: this.context.runId,
      ...(workflowMcpScopeForContext(this.context) ? { workflowMcpScope: workflowMcpScopeForContext(this.context) } : {}),
      ...(this.options.requestApproval ? { requestApproval: this.options.requestApproval } : {}),
    });
    this.client = client;
    this.detachPromise = undefined;
    try {
      await client.attach();
      await client.prompt(promptWithDeveloperInstructions(this.context.prompt, this.context.developerInstructions));
      this.context.onExit(0);
    } catch (error) {
      this.context.emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
      this.context.onExit(null);
      throw error;
    } finally {
      await this.detachWithReporting(client);
      if (this.client === client) this.client = undefined;
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    if (!client) return;
    let interruptError: unknown;
    try {
      await client.interrupt();
    } catch (error) {
      interruptError = error;
    }
    const detachError = await this.detachWithReporting(client);
    if (this.client === client) this.client = undefined;
    if (interruptError) throw interruptError;
    if (detachError) throw detachError;
  }

  private detachWithReporting(client: AcpOneShotClient): Promise<unknown | undefined> {
    if (this.detachPromise) return this.detachPromise;
    this.detachPromise = (async () => {
      try {
        await client.detach();
        return undefined;
      } catch (error) {
        this.context.emit({
          type: "system",
          content: `ACP one-shot cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return error;
      }
    })();
    return this.detachPromise;
  }
}
