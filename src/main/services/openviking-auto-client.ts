import type { JsonObject, Message } from "@openviking/sdk";

import type { OpenVikingMemoryItem } from "../../core/openviking-memory";
import type {
  OpenVikingClientPort,
  OpenVikingTaskRef,
  OpenVikingWorkspaceAuth,
  SaveOpenVikingMemoryInput,
} from "./openviking-client";

interface OpenVikingConnection {
  baseUrl: string;
  rootApiKey: string;
}

interface AutoStartingOpenVikingClientOptions {
  ensureRunning(): Promise<void>;
  getConnection(): Promise<OpenVikingConnection>;
  createClient(connection: OpenVikingConnection): OpenVikingClientPort;
}

export class AutoStartingOpenVikingClient implements OpenVikingClientPort {
  private cached: { key: string; client: OpenVikingClientPort } | null = null;

  constructor(private readonly options: AutoStartingOpenVikingClientOptions) {}

  async health(): Promise<void> {
    return (await this.client()).health();
  }

  async ensureWorkspaceUser(input: {
    accountId: string;
    userId: string;
  }): Promise<OpenVikingWorkspaceAuth> {
    return (await this.client()).ensureWorkspaceUser(input);
  }

  async deleteWorkspaceUser(accountId: string, userId: string): Promise<void> {
    return (await this.client()).deleteWorkspaceUser(accountId, userId);
  }

  async appendMessages(
    auth: OpenVikingWorkspaceAuth,
    sessionId: string,
    messages: Message[],
  ): Promise<void> {
    return (await this.client()).appendMessages(auth, sessionId, messages);
  }

  async commitSession(
    auth: OpenVikingWorkspaceAuth,
    sessionId: string,
  ): Promise<OpenVikingTaskRef> {
    return (await this.client()).commitSession(auth, sessionId);
  }

  async getTask(
    auth: OpenVikingWorkspaceAuth,
    taskId: string,
  ): Promise<JsonObject | null> {
    return (await this.client()).getTask(auth, taskId);
  }

  async searchMemories(
    auth: OpenVikingWorkspaceAuth,
    query: string,
    limit?: number,
  ): Promise<OpenVikingMemoryItem[]> {
    return (await this.client()).searchMemories(auth, query, limit);
  }

  async readMemory(auth: OpenVikingWorkspaceAuth, uri: string): Promise<string> {
    return (await this.client()).readMemory(auth, uri);
  }

  async saveMemory(
    auth: OpenVikingWorkspaceAuth,
    input: SaveOpenVikingMemoryInput,
  ): Promise<OpenVikingMemoryItem> {
    return (await this.client()).saveMemory(auth, input);
  }

  async deleteMemory(auth: OpenVikingWorkspaceAuth, uri: string): Promise<void> {
    return (await this.client()).deleteMemory(auth, uri);
  }

  private async client(): Promise<OpenVikingClientPort> {
    await this.options.ensureRunning();
    const connection = await this.options.getConnection();
    const key = `${connection.baseUrl}\0${connection.rootApiKey}`;
    if (!this.cached || this.cached.key !== key) {
      this.cached = {
        key,
        client: this.options.createClient(connection),
      };
    }
    return this.cached.client;
  }
}
