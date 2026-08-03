import { randomUUID } from "node:crypto";
import {
  OpenVikingClient,
  isOpenVikingError,
  type JsonObject,
  type Message,
} from "@openviking/sdk";

import type { OpenVikingMemoryItem } from "../../core/openviking-memory";

const MANUAL_MEMORY_URI = /^viking:\/\/user\/memories\/manual\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.md$/u;
const MANUAL_TITLE_PREFIX = /^<!-- agent-recall-title:([A-Za-z0-9_-]+) -->\r?\n/u;

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
  uri?: string;
  title: string;
  content: string;
}

export interface OpenVikingClientPort {
  health(): Promise<void>;
  ensureWorkspaceUser(input: { accountId: string; userId: string }): Promise<OpenVikingWorkspaceAuth>;
  deleteWorkspaceUser(auth: OpenVikingWorkspaceAuth): Promise<void>;
  appendMessages(
    auth: OpenVikingWorkspaceAuth,
    sessionId: string,
    messages: Message[],
  ): Promise<void>;
  commitSession(
    auth: OpenVikingWorkspaceAuth,
    sessionId: string,
    keepRecentCount?: number,
  ): Promise<OpenVikingTaskRef>;
  getTask(auth: OpenVikingWorkspaceAuth, taskId: string): Promise<JsonObject | null>;
  getTaskIfRunning?(auth: OpenVikingWorkspaceAuth, taskId: string): Promise<JsonObject | null>;
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
  userOperationRetryDelayMs?: number;
  userOperationMaxAttempts?: number;
}

export class OpenVikingGatewayError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly code: string,
    readonly statusCode?: number,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options);
    this.name = "OpenVikingGatewayError";
    this.retryable = options.retryable ?? (statusCode === 408
      || statusCode === 429
      || (statusCode !== undefined && statusCode >= 500)
      || code === "DEADLINE_EXCEEDED"
      || code === "UNAVAILABLE"
      || code === "QUEUE_UNAVAILABLE");
  }
}

export class OpenVikingGateway implements OpenVikingClientPort {
  private readonly rootClient: OpenVikingClient;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly userOperationRetryDelayMs: number;
  private readonly userOperationMaxAttempts: number;

  constructor(options: OpenVikingGatewayOptions) {
    this.baseUrl = options.baseUrl;
    this.timeout = options.timeout ?? 60_000;
    this.userOperationRetryDelayMs = options.userOperationRetryDelayMs ?? 1_000;
    this.userOperationMaxAttempts = options.userOperationMaxAttempts ?? 120;
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
    return this.retryUserRegistryOperation(() => this.normalize(async () => {
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
    }));
  }

  async deleteWorkspaceUser(auth: OpenVikingWorkspaceAuth): Promise<void> {
    await this.normalize(async () => {
      const client = this.workspaceClient(auth);
      for (const uri of [
        "viking://user/memories",
        "viking://user/peers",
        "viking://user/privacy",
        "viking://user/resources",
        "viking://user/sessions",
        "viking://user/skills",
      ]) {
        await client.remove(uri, {
          recursive: true,
          wait: true,
        });
      }
      await this.rootClient.adminRemoveUser(auth.accountId, auth.userId);
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
    keepRecentCount = 0,
  ): Promise<OpenVikingTaskRef> {
    return this.normalize(async () => {
      const result = await this.workspaceClient(auth).commitSession(
        sessionId,
        Math.max(0, Math.floor(keepRecentCount)),
      );
      return { taskId: requiredString(result, ["task_id", "taskId", "id"], "commit task ID") };
    });
  }

  async getTask(auth: OpenVikingWorkspaceAuth, taskId: string): Promise<JsonObject | null> {
    return this.normalize(() => this.workspaceClient(auth).getTask(taskId));
  }

  getTaskIfRunning(auth: OpenVikingWorkspaceAuth, taskId: string): Promise<JsonObject | null> {
    return this.getTask(auth, taskId);
  }

  async searchMemories(
    auth: OpenVikingWorkspaceAuth,
    query: string,
    limit = 20,
  ): Promise<OpenVikingMemoryItem[]> {
    return this.normalize(async () => {
      const client = this.workspaceClient(auth);
      if (!query.trim()) {
        const [listed, globbed] = await Promise.all([
          client.list("viking://user/memories", {
            recursive: true,
            nodeLimit: 1_000,
          }),
          client.glob("**/*.md", "viking://user/memories", 1_000),
        ]);
        const memories = listed
          .map(normalizeMemory)
          .filter((memory): memory is OpenVikingMemoryItem => memory !== null);
        const listedIds = new Set(memories.map((memory) => memory.id));
        const matches = Array.isArray(globbed.matches) ? globbed.matches : [];
        for (const uri of matches) {
          if (typeof uri !== "string" || listedIds.has(uri)) continue;
          const memory = normalizeMemory({
            uri,
            rel_path: uri.replace(/^viking:\/\/user\/memories\//u, ""),
          });
          if (memory) memories.push(memory);
        }
        const selected = memories
          .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
          .slice(0, limit);
        return Promise.all(selected.map(async (memory) => {
          if (!MANUAL_MEMORY_URI.test(memory.id)) return memory;
          try {
            const stored = decodeManualMemory(await client.read(memory.id));
            return {
              ...memory,
              title: stored.title || memory.title,
              content: stored.content,
            };
          } catch {
            return memory;
          }
        }));
      }
      const result = await client.find(query, {
        targetUri: "viking://user/memories",
        limit,
      });
      return (result.memories ?? [])
        .map(normalizeMemory)
        .filter((memory): memory is OpenVikingMemoryItem => memory !== null);
    });
  }

  async readMemory(auth: OpenVikingWorkspaceAuth, uri: string): Promise<string> {
    return this.normalize(async () => {
      const content = await this.workspaceClient(auth).read(uri);
      return MANUAL_MEMORY_URI.test(uri) ? decodeManualMemory(content).content : content;
    });
  }

  async saveMemory(
    auth: OpenVikingWorkspaceAuth,
    input: SaveOpenVikingMemoryInput,
  ): Promise<OpenVikingMemoryItem> {
    return this.normalize(async () => {
      const existingUri = input.uri?.trim();
      let uri: string;
      if (existingUri) {
        if (!/^viking:\/\/user\/memories\/(?:(?:identity|soul)\.md|manual\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.md)$/u.test(existingUri)) {
          throw new Error("Only manual, identity, and soul memories can be edited.");
        }
        uri = existingUri;
      } else {
        const id = input.id?.trim() || randomUUID();
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) {
          throw new Error("OpenViking manual memory ID is invalid.");
        }
        uri = `viking://user/memories/manual/${id}.md`;
      }
      const storedContent = MANUAL_MEMORY_URI.test(uri)
        ? encodeManualMemory(input.title, input.content)
        : input.content;
      await this.workspaceClient(auth).write(uri, storedContent, {
        mode: existingUri ? "replace" : "create",
        wait: true,
      });
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

  private async retryUserRegistryOperation<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.userOperationMaxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          !(error instanceof OpenVikingGatewayError)
          || error.code !== "CONFLICT"
          || !error.retryable
          || attempt === this.userOperationMaxAttempts
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, this.userOperationRetryDelayMs));
      }
    }
    throw new Error("OpenViking user operation retry loop ended unexpectedly.");
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
          {
            cause: error,
            retryable: typeof error.details?.retryable === "boolean"
              ? error.details.retryable
              : undefined,
          },
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
    result.user_key,
    result.userKey,
    result.api_key,
    result.apiKey,
    result.key,
    nested?.user_key,
    nested?.userKey,
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
  if (record.isDir === true || record.is_dir === true) return null;
  const id = stringValue(record.uri) || stringValue(record.id);
  if (!id) return null;
  const rawContent = stringValue(record.content)
    || stringValue(record.abstract)
    || stringValue(record.overview);
  const stored = MANUAL_MEMORY_URI.test(id)
    ? decodeManualMemory(rawContent)
    : { title: "", content: rawContent };
  const name = stored.title
    || stringValue(record.title)
    || stringValue(record.name)
    || id.split("/").at(-1)
    || id;
  const relativePath = stringValue(record.rel_path) || stringValue(record.relPath);
  const source = stringValue(record.source) || relativePath.split("/")[0] || "";
  const updatedAt = stringValue(record.modTime)
    || stringValue(record.mod_time)
    || stringValue(record.updatedAt);
  return {
    id,
    workspaceId: "",
    title: name.replace(/\.md$/iu, ""),
    content: stored.content,
    ...(source ? { source } : {}),
    ...(typeof record.score === "number" ? { score: record.score } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function encodeManualMemory(title: string, content: string): string {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return content;
  const encodedTitle = Buffer.from(normalizedTitle, "utf8").toString("base64url");
  return `<!-- agent-recall-title:${encodedTitle} -->\n${content}`;
}

function decodeManualMemory(content: string): { title: string; content: string } {
  const match = MANUAL_TITLE_PREFIX.exec(content);
  if (!match) return { title: "", content };
  try {
    const title = Buffer.from(match[1], "base64url").toString("utf8").trim();
    return {
      title,
      content: content.slice(match[0].length),
    };
  } catch {
    return { title: "", content };
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
