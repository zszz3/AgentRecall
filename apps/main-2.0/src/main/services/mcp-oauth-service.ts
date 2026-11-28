import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpOAuthStatus } from "../../automation/engine/shared/mcp/types";
import type { McpCredentialService } from "./mcp-credential-service";

const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60_000;

export interface McpOAuthServiceOptions {
  credentials: McpCredentialService;
  openExternal: (url: string) => Promise<void> | void;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

interface PendingCallback {
  server: http.Server;
  abort: () => void;
  revoked: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function callbackHtml(title: string, message: string, success: boolean): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:72px auto;padding:24px;color:#111;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;"><h1>${success ? "✓ " : "✕ "}${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

export class McpOAuthService {
  private readonly pendingCallbacks = new Map<string, PendingCallback>();
  private readonly timeoutMs: number;

  constructor(private readonly options: McpOAuthServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
  }

  /**
   * Non-interactive provider attached to runtime Streamable HTTP / SSE transports.
   * Supplies encrypted tokens and allows transparent refresh_token rotation,
   * while failing loudly with an actionable message if interactive login is needed.
   */
  createRuntimeProvider(serverId: string): OAuthClientProvider {
    return this.buildProvider(serverId, {
      redirectUrl: "http://127.0.0.1/oauth/callback",
      onRedirect: () => {
        throw new Error(
          "OAuth authorization is required for this MCP server. Open AgentRecall MCP settings and click 'Sign in with OAuth'.",
        );
      },
    });
  }

  async authorizeServer(serverId: string, serverUrl: string): Promise<McpOAuthStatus> {
    const parsedUrl = new URL(serverUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("OAuth authorization requires an HTTP or HTTPS MCP server URL.");
    }

    // Cancel any previous pending login flow for the same server before starting a new one.
    this.cancelPending(serverId);

    const expectedState = randomBytes(24).toString("hex");
    let resolveCallback!: (code: string) => void;
    let rejectCallback!: (error: Error) => void;
    const callbackPromise = new Promise<string>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    // Suppress Node's early unhandledRejection if the loopback callback rejects while
    // `openExternal` / `auth()` is still resolving before `await callbackPromise`.
    callbackPromise.catch(() => undefined);

    let settled = false;
    const settleResolve = (code: string) => {
      if (settled) return;
      settled = true;
      resolveCallback(code);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectCallback(error);
    };

    const callbackServer = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/oauth/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const errorParam = requestUrl.searchParams.get("error");
      const errorDescription = requestUrl.searchParams.get("error_description");
      if (errorParam) {
        const message = errorDescription ? `${errorParam}: ${errorDescription}` : errorParam;
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(callbackHtml("OAuth 授权失败", message, false));
        settleReject(new Error(`OAuth authorization failed: ${message}`));
        return;
      }
      const returnedState = requestUrl.searchParams.get("state");
      if (returnedState !== expectedState) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(callbackHtml("OAuth 状态校验失败", "授权状态参数不匹配，请回到 AgentRecall 重新发起登录。", false));
        settleReject(new Error("OAuth state mismatch."));
        return;
      }
      const code = requestUrl.searchParams.get("code")?.trim();
      if (!code) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(callbackHtml("缺少授权码", "回调 URL 缺少 authorization code。", false));
        settleReject(new Error("OAuth callback did not include an authorization code."));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(callbackHtml("授权成功", "已完成 MCP OAuth 授权，可以关闭此标签页并返回 AgentRecall。", true));
      settleResolve(code);
    });

    await new Promise<void>((resolve, reject) => {
      callbackServer.once("error", reject);
      callbackServer.listen(0, "127.0.0.1", () => {
        callbackServer.off("error", reject);
        resolve();
      });
    });

    const port = (callbackServer.address() as AddressInfo).port;
    const redirectUrl = `http://127.0.0.1:${port}/oauth/callback`;
    const timer = setTimeout(() => {
      settleReject(new Error("OAuth authorization timed out before the browser callback completed."));
    }, this.timeoutMs);
    timer.unref?.();

    const cleanup = async () => {
      clearTimeout(timer);
      this.pendingCallbacks.delete(serverId);
      await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
    };

    const pendingEntry: PendingCallback = {
      server: callbackServer,
      revoked: false,
      abort: () => {
        settleReject(new Error("OAuth authorization was cancelled."));
      },
    };
    this.pendingCallbacks.set(serverId, pendingEntry);

    // Snapshot any prior OAuth session and clear stale state before starting a fresh interactive flow:
    // this guarantees Re-authorize always opens the browser, registers against the new ephemeral loopback
    // redirect_uri, and re-discovers metadata if the server URL changed. If the user cancels or the flow
    // fails (without an explicit revoke), restore the previous valid session.
    let previousState: ReturnType<McpCredentialService["getOAuthState"]>;
    try {
      previousState = this.options.credentials.getOAuthState(serverId);
    } catch {
      previousState = undefined;
    }
    this.options.credentials.clearOAuthState(serverId, "all");

    let completed = false;
    try {
      let redirected = false;
      const provider = this.buildProvider(serverId, {
        redirectUrl,
        state: expectedState,
        onRedirect: async (authorizationUrl) => {
          redirected = true;
          await this.options.openExternal(authorizationUrl.toString());
        },
      });

      const firstResult = await auth(provider, {
        serverUrl: parsedUrl,
        ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
      });
      if (firstResult === "AUTHORIZED") {
        completed = true;
        return this.options.credentials.getOAuthStatus(serverId);
      }
      if (!redirected) {
        throw new Error("OAuth server requested redirect without providing an authorization URL.");
      }

      const code = await callbackPromise;
      const finalResult = await auth(provider, {
        serverUrl: parsedUrl,
        authorizationCode: code,
        ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
      });
      if (finalResult !== "AUTHORIZED") {
        throw new Error("OAuth token exchange did not complete authorization.");
      }
      completed = true;
      return this.options.credentials.getOAuthStatus(serverId);
    } finally {
      if (!completed && !pendingEntry.revoked) {
        if (previousState?.tokens?.access_token) {
          this.options.credentials.saveOAuthState(serverId, () => previousState!);
        } else {
          this.options.credentials.clearOAuthState(serverId, "all");
        }
      }
      await cleanup();
    }
  }

  revokeServer(serverId: string): void {
    const pending = this.pendingCallbacks.get(serverId);
    if (pending) pending.revoked = true;
    this.cancelPending(serverId);
    this.options.credentials.clearOAuthState(serverId, "all");
  }

  shutdown(): void {
    for (const serverId of [...this.pendingCallbacks.keys()]) {
      this.cancelPending(serverId);
    }
  }

  private cancelPending(serverId: string): void {
    const pending = this.pendingCallbacks.get(serverId);
    if (!pending) return;
    pending.abort();
    pending.server.close();
    this.pendingCallbacks.delete(serverId);
  }

  private buildProvider(
    serverId: string,
    config: {
      redirectUrl: string;
      state?: string;
      onRedirect: (authorizationUrl: URL) => void | Promise<void>;
    },
  ): OAuthClientProvider {
    const credentials = this.options.credentials;
    return {
      get redirectUrl(): string {
        return config.redirectUrl;
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: "AgentRecall",
          redirect_uris: [config.redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      ...(config.state ? { state: () => config.state! } : {}),
      clientInformation: (): OAuthClientInformationMixed | undefined =>
        credentials.getOAuthState(serverId)?.clientInformation,
      saveClientInformation: (info: OAuthClientInformationMixed) => {
        credentials.saveOAuthState(serverId, (current) => ({
          ...current,
          clientInformation: info,
          updatedAt: Date.now(),
        }));
      },
      tokens: (): OAuthTokens | undefined =>
        credentials.getOAuthState(serverId)?.tokens,
      saveTokens: (tokens: OAuthTokens) => {
        credentials.saveOAuthState(serverId, (current) => ({
          ...current,
          tokens,
          updatedAt: Date.now(),
        }));
      },
      redirectToAuthorization: (authorizationUrl: URL) => config.onRedirect(authorizationUrl),
      saveCodeVerifier: (codeVerifier: string) => {
        credentials.saveOAuthState(serverId, (current) => ({
          ...current,
          codeVerifier,
        }));
      },
      codeVerifier: (): string => {
        const verifier = credentials.getOAuthState(serverId)?.codeVerifier;
        if (!verifier) throw new Error("Missing OAuth PKCE code verifier.");
        return verifier;
      },
      invalidateCredentials: (scope) => {
        credentials.clearOAuthState(serverId, scope);
      },
      saveDiscoveryState: (state: OAuthDiscoveryState) => {
        credentials.saveOAuthState(serverId, (current) => ({
          ...current,
          discoveryState: state,
        }));
      },
      discoveryState: (): OAuthDiscoveryState | undefined =>
        credentials.getOAuthState(serverId)?.discoveryState,
    };
  }
}
