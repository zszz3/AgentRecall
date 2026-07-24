import { randomUUID } from "node:crypto";
import {
  OpenVikingClient,
  isOpenVikingError,
  type JsonObject,
  type Message,
} from "@openviking/sdk";

import type { OpenVikingMemoryItem } from "../../core/openviking-memory";

export interface OpenVikingWorkspaceAuth {
  accountId: string;
  userId: string;
  apiKey: string;
}

export interface OpenVikingTaskRef {
  taskId: string;
}

export interface SaveOpenVikingMemoryInput {
  id?: string;
  title: string;
  content: string;
}

export interface OpenVikingClientPort {
  health(): Promise<void>;
  ensureWorkspaceUser(input: { accountId: string; userId: string }): Promise<OpenVikingWorkspaceAuth>;
  deleteWorkspaceUser(accountId: string, userId: string): Promise<void>;
  appendMessages(
    auth: OpenVikingWorkspaceAuth,
    sessionId: string,
    messages: Message[],
  ): Promise<void>;
  commitSession(auth: OpenVikingWorkspaceAuth, sessionId: string): Promise<OpenVikingTaskRef>;
  getTask(auth: OpenVikingWorkspaceAuth, taskId: string): Promise<JsonObject | null>;
  searchMemories(
    auth: OpenVikingWorkspaceAuth,
    query: string,
    limit?: number,
  ): Promise<OpenVikingMemoryItem[]>;
  readMemory(auth: OpenVikingWorkspaceAuth, uri: string): Promise<string>;
  saveMemory(
    auth: OpenVikingWorkspaceAuth,
    input: SaveOpenVikingMemoryInput,
  ): Promise<OpenVikingMemoryItem>;
  deleteMemory(auth: OpenVikingWorkspaceAuth, uri: string): Promise<void>;
}

interface OpenVikingGatewayOptions {
  baseUrl: string;
  rootApiKey: string;
  timeout?: number;
}

export class OpenVikingGatewayError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly code: string,
    readonly statusCode?: number,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "OpenVikingGatewayError";
    this.retryable = statusCode === 408
      || statusCode === 429
      || (statusCode !== undefined && statusCode >= 500)
      || code === "DEADLINE_EXCEEDED"
      || code === "UNAVAILABLE"
      || code === "QUEUE_UNAVAILABLE";
  }
}

export class OpenVikingGateway implements OpenVikingClientPort {
  private readonly rootClient: OpenVikingClient;
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(options: OpenVikingGatewayOptions) {
    this.baseUrl = options.baseUrl;
    this.timeout = options.timeout ?? 60_000;
    this.rootClient = new OpenVikingClient({
      baseUrl: options.baseUrl,
      apiKey: options.rootApiKey,
      timeout: this.timeout,
    });
  }

  async health(): Promise<void> {
    await this.normalize(async () => {
      if (!await this.rootClient.health()) throw new Error("OpenViking health check returned unhealthy.");
    });
  }

  async ensureWorkspaceUser(input: {
    accountId: string;
    userId: string;
  }): Promise<OpenVikingWorkspaceAuth> {
    return this.normalize(async () => {
      const accounts = await this.rootClient.adminListAccounts();
      const accountExists = accounts.some((account) => recordIdentifier(account, "account") === input.accountId);
      let result: JsonObject;
      if (!accountExists) {
        result = await this.rootClient.adminCreateAccount(input.accountId, input.userId);
      } else {
        const users = await this.rootClient.adminListUsers(input.accountId);
        const userExists = users.some((user) => recordIdentifier(user, "user") === input.userId);
        result = userExists
          ? await this.rootClient.adminRegenerateKey(input.accountId, input.userId)
          : await this.rootClient.adminRegisterUser(input.accountId, input.userId, "member");
      }
      return {
        accountId: input.accountId,
        userId: input.userId,
        apiKey: extractApiKey(result),
      };
    });
  }

  async deleteWorkspaceUser(accountId: string, userId: string): Promise<void> {
    await this.normalize(async () => {
      await this.rootClient.adminRemoveUser(accountId, userId);
    });
  }

  async appendMessages(
    auth: OpenVikingWorkspaceAuth,
    sessionId: string,
    messages: Message[],
  ): Promise<void> {
    await this.normalize(async () => {
      const client = this.workspaceClient(auth);
      await client.getSession(sessionId, true);
      await client.batchAddMessages(sessionId, messages);
    });
  }

  async commitSession(
    auth: OpenVikingWorkspaceAuth,
    sessionId: string,
  ): Promise<OpenVikingTaskRef> {
    return this.normalize(async () => {
      const result = await this.workspaceClient(auth).commitSession(sessionId);
      return { taskId: requiredString(result, ["task_id", "taskId", "id"], "commit task ID") };
    });
  }

  async getTask(auth: OpenVikingWorkspaceAuth, taskId: string): Promise<JsonObject | null> {
    return this.normalize(() => this.workspaceClient(auth).getTask(taskId));
  }

  async searchMemories(
    auth: OpenVikingWorkspaceAuth,
    query: string,
    limit = 20,
  ): Promise<OpenVikingMemoryItem[]> {
    return this.normalize(async () => {
      const result = await this.workspaceClient(auth).find(query, {
        targetUri: "viking://user/memories",
        limit,
      });
      return (result.memories ?? [])
        .map(normalizeMemory)
        .filter((memory): memory is OpenVikingMemoryItem => memory !== null);
    });
  }

  async readMemory(auth: OpenVikingWorkspaceAuth, uri: string): Promise<string> {
    return this.normalize(() => this.workspaceClient(auth).read(uri));
  }

  async saveMemory(
    auth: OpenVikingWorkspaceAuth,
    input: SaveOpenVikingMemoryInput,
  ): Promise<OpenVikingMemoryItem> {
    return this.normalize(async () => {
      const id = input.id?.trim() || randomUUID();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) {
        throw new Error("OpenViking manual memory ID is invalid.");
      }
      const uri = `viking://user/memories/manual/${id}.md`;
      await this.workspaceClient(auth).write(uri, input.content, { wait: true });
      return {
        id: uri,
        workspaceId: "",
        title: input.title.trim(),
        content: input.content,
      };
    });
  }

  async deleteMemory(auth: OpenVikingWorkspaceAuth, uri: string): Promise<void> {
    await this.normalize(async () => {
      await this.workspaceClient(auth).remove(uri, { wait: true });
    });
  }

  private workspaceClient(auth: OpenVikingWorkspaceAuth): OpenVikingClient {
    return new OpenVikingClient({
      baseUrl: this.baseUrl,
      apiKey: auth.apiKey,
      account: auth.accountId,
      user: auth.userId,
      timeout: this.timeout,
    });
  }

  private async normalize<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof OpenVikingGatewayError) throw error;
      if (isOpenVikingError(error)) {
        throw new OpenVikingGatewayError(
          error.message,
          error.code || "OPENVIKING_ERROR",
          error.statusCode,
          { cause: error },
        );
      }
      throw new OpenVikingGatewayError(
        error instanceof Error ? error.message : "OpenViking request failed.",
        "CLIENT_ERROR",
        undefined,
        { cause: error },
      );
    }
  }
}

function recordIdentifier(value: unknown, kind: "account" | "user"): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const candidates = kind === "account"
    ? [record.account_id, record.accountId, record.id]
    : [record.user_id, record.userId, record.id];
  return candidates.find((candidate): candidate is string => typeof candidate === "string") ?? "";
}

function extractApiKey(result: JsonObject): string {
  const nested = result.user && typeof result.user === "object"
    ? result.user as Record<string, unknown>
    : undefined;
  const value = [
    result.api_key,
    result.apiKey,
    result.key,
    nested?.api_key,
    nested?.apiKey,
  ].find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  if (!value) throw new Error("OpenViking user response did not include an API key.");
  return value;
}

function requiredString(record: JsonObject, keys: string[], label: string): string {
  const value = keys
    .map((key) => record[key])
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  if (!value) throw new Error(`OpenViking response did not include ${label}.`);
  return value;
}

function normalizeMemory(value: unknown): OpenVikingMemoryItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.uri) || stringValue(record.id);
  if (!id) return null;
  return {
    id,
    workspaceId: "",
    title: stringValue(record.title) || stringValue(record.name) || id.split("/").at(-1) || id,
    content: stringValue(record.content) || stringValue(record.abstract) || stringValue(record.overview),
    ...(stringValue(record.source) ? { source: stringValue(record.source) } : {}),
    ...(typeof record.score === "number" ? { score: record.score } : {}),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
