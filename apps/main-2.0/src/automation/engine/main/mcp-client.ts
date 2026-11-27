import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpServerDefinition,
  McpServerRuntimeState,
  McpToolDefinition,
} from "../shared/mcp/types";

export type ResolvedMcpTransportMode = "stdio" | "streamable-http" | "sse";

export interface McpClientConnectOptions {
  literalEnv?: Record<string, string>;
  storedSecrets?: {
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
  authProvider?: OAuthClientProvider;
  /** Optional version token (e.g. OAuth updatedAt) so pool evicts on re-authorization. */
  authRevision?: string;
}

export interface ConnectedMcpClient {
  client: Client;
  transport: Transport;
  transportMode: ResolvedMcpTransportMode;
}

export interface McpConnectionPoolOptions {
  /** Close idle pooled connections after this duration. Defaults to 10 minutes. */
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  connect?: (
    server: McpServerDefinition,
    clientName: string,
    connectOptions?: Record<string, string> | McpClientConnectOptions,
    timeoutMs?: number,
  ) => Promise<ConnectedMcpClient>;
  now?: () => number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const SSE_FALLBACK_HTTP_STATUSES = new Set([404, 405, 406, 415, 501]);
const NON_FATAL_RPC_ERROR_CODES = new Set<number>([
  ErrorCode.InvalidRequest,
  ErrorCode.MethodNotFound,
  ErrorCode.InvalidParams,
]);

function normalizeConnectOptions(
  input?: Record<string, string> | McpClientConnectOptions,
): McpClientConnectOptions {
  if (!input) return {};
  if (
    "literalEnv" in input
    || "storedSecrets" in input
    || "authProvider" in input
    || "authRevision" in input
  ) {
    return input as McpClientConnectOptions;
  }
  return { literalEnv: input as Record<string, string> };
}

export function findMissingHostEnvVars(
  server: McpServerDefinition,
  storedKeys?: { envKeys?: readonly string[]; headerKeys?: readonly string[] },
  hostEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const storedEnv = new Set(storedKeys?.envKeys ?? []);
  const storedHeaders = new Set(storedKeys?.headerKeys ?? []);
  const missing = new Set<string>();
  for (const [key, hostName] of Object.entries(server.env ?? {})) {
    if (storedEnv.has(key)) continue;
    const trimmed = hostName.trim();
    if (trimmed && hostEnv[trimmed] === undefined) missing.add(trimmed);
  }
  for (const [key, hostName] of Object.entries(server.headers ?? {})) {
    if (storedHeaders.has(key)) continue;
    const trimmed = hostName.trim();
    if (trimmed && hostEnv[trimmed] === undefined) missing.add(trimmed);
  }
  return [...missing].sort((left, right) => left.localeCompare(right));
}

function resolvedEnv(server: McpServerDefinition, options: McpClientConnectOptions): Record<string, string> {
  if (options.literalEnv) return options.literalEnv;
  const fromHost = Object.fromEntries(
    Object.entries(server.env).map(([key, envName]) => [key, process.env[envName] ?? ""]),
  );
  return {
    ...fromHost,
    ...(options.storedSecrets?.env ?? {}),
  };
}

// Header values reference host environment variable names, mirroring `env`, with locally stored encrypted overrides.
function resolvedHeaders(server: McpServerDefinition, options: McpClientConnectOptions): Record<string, string> {
  const fromHost = Object.fromEntries(
    Object.entries(server.headers ?? {})
      .filter(([name, hostName]) => name.trim() && hostName.trim())
      .map(([name, hostName]) => [name, process.env[hostName] ?? ""]),
  );
  return {
    ...fromHost,
    ...(options.storedSecrets?.headers ?? {}),
  };
}

function createSseTransport(
  url: URL,
  headers: Record<string, string>,
  authProvider?: OAuthClientProvider,
): SSEClientTransport {
  const hasHeaders = Object.keys(headers).length > 0;
  if (!hasHeaders && !authProvider) {
    return new SSEClientTransport(url);
  }
  return new SSEClientTransport(url, {
    ...(authProvider ? { authProvider } : {}),
    ...(hasHeaders ? { requestInit: { headers } } : {}),
    ...(hasHeaders && !authProvider
      ? {
          eventSourceInit: {
            fetch: (input, init) => {
              const merged = new Headers(init?.headers);
              for (const [name, value] of Object.entries(headers)) {
                if (!merged.has(name)) merged.set(name, value);
              }
              return fetch(input, { ...init, headers: merged });
            },
          },
        }
      : {}),
  });
}

function shouldFallbackToSse(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; status?: unknown; message?: unknown };
  const status = typeof record.code === "number"
    ? record.code
    : typeof record.status === "number"
      ? record.status
      : undefined;
  if (status === 401 || status === 403) return false;
  if (status !== undefined && SSE_FALLBACK_HTTP_STATUSES.has(status)) return true;

  const message = typeof record.message === "string" ? record.message : "";
  if (/timed out/i.test(message)) return false;
  if (/\b(?:401|403)\b/.test(message)) return false;
  return /\b(?:404|405|406|415|501)\b/.test(message)
    || /method not allowed|text\/event-stream|invalid content type|not acceptable|unsupported media type/i.test(message);
}

export async function connectMcpClient(
  server: McpServerDefinition,
  clientName: string,
  connectOptions?: Record<string, string> | McpClientConnectOptions,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<ConnectedMcpClient> {
  const options = normalizeConnectOptions(connectOptions);
  if (server.transport !== "http") {
    const client = new Client({ name: clientName, version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: required(server.command, "command"),
      args: server.args,
      env: resolvedEnv(server, options),
    });
    try {
      await withTimeout(client.connect(transport as Transport), timeoutMs);
      return { client, transport: transport as Transport, transportMode: "stdio" };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw enrichMissingEnvError(error, server, options);
    }
  }

  const url = new URL(required(server.url, "HTTP URL"));
  const headers = resolvedHeaders(server, options);
  const streamableClient = new Client({ name: clientName, version: "0.1.0" });
  const streamableTransport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    ...(options.authProvider ? { authProvider: options.authProvider } : {}),
  });
  try {
    await withTimeout(streamableClient.connect(streamableTransport as Transport), timeoutMs);
    return {
      client: streamableClient,
      transport: streamableTransport as Transport,
      transportMode: "streamable-http",
    };
  } catch (streamableError) {
    await streamableClient.close().catch(() => undefined);
    if (!shouldFallbackToSse(streamableError)) {
      throw enrichMissingEnvError(streamableError, server, options);
    }

    const sseClient = new Client({ name: clientName, version: "0.1.0" });
    const sseTransport = createSseTransport(url, headers, options.authProvider);
    try {
      await withTimeout(sseClient.connect(sseTransport as Transport), timeoutMs);
      return {
        client: sseClient,
        transport: sseTransport as Transport,
        transportMode: "sse",
      };
    } catch (sseError) {
      await sseClient.close().catch(() => undefined);
      const primaryMsg = streamableError instanceof Error ? streamableError.message : String(streamableError);
      const fallbackMsg = sseError instanceof Error ? sseError.message : String(sseError);
      throw enrichMissingEnvError(
        new Error(`Streamable HTTP failed (${primaryMsg}); SSE fallback failed (${fallbackMsg})`, {
          cause: sseError,
        }),
        server,
        options,
      );
    }
  }
}

function enrichMissingEnvError(
  error: unknown,
  server: McpServerDefinition,
  options: McpClientConnectOptions,
): unknown {
  if (options.literalEnv) return error;
  const missing = findMissingHostEnvVars(server, {
    envKeys: Object.keys(options.storedSecrets?.env ?? {}),
    headerKeys: Object.keys(options.storedSecrets?.headers ?? {}),
  });
  if (missing.length === 0) return error;
  const baseMessage = error instanceof Error ? error.message : String(error);
  return new Error(
    `${baseMessage} (missing host environment variable(s): ${missing.join(", ")})`,
    { cause: error },
  );
}

export async function discoverMcpTools(
  server: McpServerDefinition,
  connectOptions?: Record<string, string> | McpClientConnectOptions,
): Promise<McpToolDefinition[]> {
  const { client } = await connectMcpClient(server, "agent-recall-v2", connectOptions, DEFAULT_CONNECT_TIMEOUT_MS);
  try {
    const result = await withTimeout(client.listTools(), DEFAULT_CONNECT_TIMEOUT_MS);
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema as Record<string, unknown>,
      ...(tool.annotations?.readOnlyHint === true ? { readOnly: true } : {}),
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function invokeMcpTool(
  server: McpServerDefinition,
  toolName: string,
  args: Record<string, unknown>,
  connectOptions?: Record<string, string> | McpClientConnectOptions,
): Promise<unknown> {
  const { client } = await connectMcpClient(server, "agent-recall-v2-gateway", connectOptions, DEFAULT_CONNECT_TIMEOUT_MS);
  try {
    return await withTimeout(client.callTool({ name: toolName, arguments: args }), DEFAULT_CALL_TIMEOUT_MS);
  } finally {
    await client.close().catch(() => undefined);
  }
}

interface PooledEntry {
  signature: string;
  connectPromise?: Promise<ConnectedMcpClient>;
  connection?: ConnectedMcpClient;
  activeCalls: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

/**
 * Owns reusable MCP client connections (STDIO child processes and HTTP/SSE sessions)
 * so stateful servers (e.g. Playwright, database sessions) retain state across tool
 * calls and avoid repeated cold starts.
 */
export class McpConnectionPool {
  private readonly idleTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly connectFn: NonNullable<McpConnectionPoolOptions["connect"]>;
  private readonly now: () => number;
  private readonly entries = new Map<string, PooledEntry>();
  private readonly statuses = new Map<string, McpServerRuntimeState>();
  private disposed = false;

  constructor(options: McpConnectionPoolOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.connectFn = options.connect ?? connectMcpClient;
    this.now = options.now ?? (() => Date.now());
  }

  getRuntimeState(serverId: string): McpServerRuntimeState {
    const state = this.statuses.get(serverId);
    return state ? { ...state } : { state: "idle" };
  }

  async invokeTool(
    server: McpServerDefinition,
    toolName: string,
    args: Record<string, unknown>,
    connectOptions?: Record<string, string> | McpClientConnectOptions,
  ): Promise<unknown> {
    if (this.disposed) {
      throw new Error("MCP connection pool is closed.");
    }
    const { entry, connection } = await this.acquire(server, connectOptions);
    entry.activeCalls += 1;
    this.clearIdleTimer(entry);
    try {
      const result = await withTimeout(
        connection.client.callTool({ name: toolName, arguments: args }),
        this.callTimeoutMs,
      );
      if (!entry.closed) {
        this.statuses.set(server.id, {
          state: "running",
          transportMode: connection.transportMode,
          lastUsedAt: this.now(),
        });
      }
      return result;
    } catch (error) {
      if (shouldEvictConnectionOnError(error, entry)) {
        const message = error instanceof Error ? error.message : String(error);
        await this.disposeEntry(server.id, entry, {
          state: "error",
          transportMode: connection.transportMode,
          lastUsedAt: this.now(),
          lastError: message,
        });
      }
      throw error;
    } finally {
      entry.activeCalls = Math.max(0, entry.activeCalls - 1);
      if (!entry.closed && entry.activeCalls === 0) {
        this.scheduleIdleEviction(server.id, entry);
      }
    }
  }

  async evict(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) {
      this.statuses.delete(serverId);
      return;
    }
    await this.disposeEntry(serverId, entry);
  }

  async closeAll(): Promise<void> {
    this.disposed = true;
    const pending = [...this.entries.entries()].map(([serverId, entry]) =>
      this.disposeEntry(serverId, entry),
    );
    await Promise.allSettled(pending);
    this.entries.clear();
    this.statuses.clear();
  }

  private async acquire(
    server: McpServerDefinition,
    connectOptions?: Record<string, string> | McpClientConnectOptions,
  ): Promise<{ entry: PooledEntry; connection: ConnectedMcpClient }> {
    const normalizedOptions = normalizeConnectOptions(connectOptions);
    const signature = runtimeConnectionSignature(server, normalizedOptions);
    const existing = this.entries.get(server.id);
    if (existing && !existing.closed) {
      if (existing.signature === signature) {
        if (existing.connection) {
          return { entry: existing, connection: existing.connection };
        }
        if (existing.connectPromise) {
          const connection = await existing.connectPromise;
          if (!existing.closed && !this.disposed) {
            return { entry: existing, connection };
          }
          // Evicted while we awaited connect; retry cleanly below if pool is still open.
          if (this.disposed) throw new Error("MCP connection pool is closed.");
        }
      } else {
        await this.disposeEntry(server.id, existing);
      }
    }

    const entry: PooledEntry = {
      signature,
      activeCalls: 0,
      closed: false,
    };
    this.entries.set(server.id, entry);
    this.statuses.set(server.id, { state: "connecting" });

    const connectPromise = this.connectFn(
      server,
      "agent-recall-v2-gateway",
      connectOptions,
      this.connectTimeoutMs,
    );
    entry.connectPromise = connectPromise;

    try {
      const connection = await connectPromise;
      if (entry.closed || this.disposed || this.entries.get(server.id) !== entry) {
        await connection.client.close().catch(() => undefined);
        throw new Error("MCP connection was closed while connecting.");
      }
      entry.connection = connection;
      entry.connectPromise = undefined;
      this.attachTransportLifecycle(server.id, entry, connection);
      this.statuses.set(server.id, {
        state: "running",
        transportMode: connection.transportMode,
        lastUsedAt: this.now(),
      });
      return { entry, connection };
    } catch (error) {
      entry.connectPromise = undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (this.entries.get(server.id) === entry) {
        this.entries.delete(server.id);
        if (!this.disposed && !entry.closed) {
          this.statuses.set(server.id, { state: "error", lastError: message });
        }
      }
      entry.closed = true;
      throw error;
    }
  }

  private attachTransportLifecycle(
    serverId: string,
    entry: PooledEntry,
    connection: ConnectedMcpClient,
  ): void {
    const previousOnClose = connection.client.onclose;
    connection.client.onclose = () => {
      previousOnClose?.();
      if (entry.closed || this.entries.get(serverId) !== entry) return;
      entry.closed = true;
      this.clearIdleTimer(entry);
      this.entries.delete(serverId);
      if (!this.disposed) {
        this.statuses.delete(serverId);
      }
    };

    const previousOnError = connection.client.onerror;
    connection.client.onerror = (error) => {
      previousOnError?.(error);
      if (entry.closed || this.entries.get(serverId) !== entry) return;
      const message = error instanceof Error ? error.message : String(error);
      this.statuses.set(serverId, {
        state: "error",
        transportMode: connection.transportMode,
        lastUsedAt: this.now(),
        lastError: message,
      });
    };
  }

  private scheduleIdleEviction(serverId: string, entry: PooledEntry): void {
    this.clearIdleTimer(entry);
    if (this.idleTimeoutMs <= 0) return;
    entry.idleTimer = setTimeout(() => {
      if (entry.activeCalls > 0 || entry.closed) return;
      void this.disposeEntry(serverId, entry);
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private clearIdleTimer(entry: PooledEntry): void {
    if (!entry.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private async disposeEntry(
    serverId: string,
    entry: PooledEntry,
    nextStatus?: McpServerRuntimeState,
  ): Promise<void> {
    if (entry.closed) {
      if (this.entries.get(serverId) === entry) this.entries.delete(serverId);
      return;
    }
    entry.closed = true;
    this.clearIdleTimer(entry);
    if (this.entries.get(serverId) === entry) {
      this.entries.delete(serverId);
    }
    if (nextStatus && !this.disposed) {
      this.statuses.set(serverId, nextStatus);
    } else {
      this.statuses.delete(serverId);
    }

    const connection = entry.connection;
    entry.connection = undefined;
    if (connection) {
      await connection.client.close().catch(() => undefined);
    }
  }
}

function shouldEvictConnectionOnError(error: unknown, entry: PooledEntry): boolean {
  if (entry.closed) return true;
  if (error instanceof McpError && NON_FATAL_RPC_ERROR_CODES.has(error.code)) {
    return false;
  }
  return true;
}

function runtimeConnectionSignature(
  server: McpServerDefinition,
  options: McpClientConnectOptions,
): string {
  const env = sortedRecord(resolvedEnv(server, options));
  const headers = sortedRecord(resolvedHeaders(server, options));
  return JSON.stringify({
    transport: server.transport,
    command: server.command?.trim() ?? "",
    args: server.args,
    url: server.url?.trim() ?? "",
    env,
    headers,
    authRevision: options.authRevision ?? "",
  });
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`MCP ${label} is required`);
  return value.trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("MCP connection timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
