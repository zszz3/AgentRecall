import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  McpCredentialService,
  type McpCredentialBackingStore,
  type McpCredentialEncryption,
} from "./mcp-credential-service";
import { McpOAuthService } from "./mcp-oauth-service";

function createCredentials() {
  const data: Record<string, unknown> = {};
  const store: McpCredentialBackingStore = {
    get: ((key: string) => data[key]) as McpCredentialBackingStore["get"],
    set: ((key: string, value: unknown) => { data[key] = value; }) as McpCredentialBackingStore["set"],
  };
  const encryption: McpCredentialEncryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buf) => buf.toString("utf8").slice(4),
  };
  return new McpCredentialService(store, encryption);
}

describe("McpOAuthService", () => {
  const servers: http.Server[] = [];
  const services: McpOAuthService[] = [];

  afterEach(async () => {
    for (const service of services.splice(0)) service.shutdown();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("completes an end-to-end OAuth 2.1 PKCE loopback authorization flow and stores encrypted tokens", async () => {
    let baseUrl = "";
    let registerCount = 0;
    let tokenIssueCount = 0;
    const registeredRedirectUris = new Map<string, string[]>();
    const authServer = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", baseUrl);
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }));
        return;
      }
      if (url.pathname === "/register" && request.method === "POST") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(chunk as Buffer));
        request.on("end", () => {
          registerCount += 1;
          const clientId = `dyn-client-${registerCount}`;
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          registeredRedirectUris.set(clientId, (body.redirect_uris as string[]) ?? []);
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({
            client_id: clientId,
            redirect_uris: body.redirect_uris,
          }));
        });
        return;
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(chunk as Buffer));
        request.on("end", () => {
          const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          const clientId = params.get("client_id") ?? "";
          const redirectUri = params.get("redirect_uri") ?? "";
          if (params.get("code") !== "auth-code-xyz" || !registeredRedirectUris.get(clientId)?.includes(redirectUri)) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          tokenIssueCount += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            access_token: `oauth-access-token-${tokenIssueCount}`,
            refresh_token: `oauth-refresh-token-${tokenIssueCount}`,
            token_type: "bearer",
            expires_in: 3600,
            scope: "mcp:read",
          }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    servers.push(authServer);
    await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (authServer.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    let failBrowserLogin = false;
    let browserOpens = 0;
    const credentials = createCredentials();
    const oauth = new McpOAuthService({
      credentials,
      timeoutMs: 10_000,
      openExternal: async (authorizationUrl) => {
        browserOpens += 1;
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri")!;
        const state = parsed.searchParams.get("state")!;
        if (failBrowserLogin) {
          await fetch(`${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`);
          return;
        }
        const callbackResponse = await fetch(`${redirectUri}?code=auth-code-xyz&state=${encodeURIComponent(state)}`);
        expect(callbackResponse.status).toBe(200);
      },
    });
    services.push(oauth);

    const status = await oauth.authorizeServer("linear", `${baseUrl}/mcp`);
    expect(status).toMatchObject({ status: "authorized", scope: "mcp:read" });
    expect(credentials.getOAuthState("linear")?.tokens?.access_token).toBe("oauth-access-token-1");

    // Re-authorization must open the browser again and register against the new loopback port
    // instead of reusing stale client_id or silently refreshing old tokens.
    const reauthStatus = await oauth.authorizeServer("linear", `${baseUrl}/mcp`);
    expect(reauthStatus).toMatchObject({ status: "authorized", scope: "mcp:read" });
    expect(browserOpens).toBe(2);
    expect(registerCount).toBe(2);
    expect(credentials.getOAuthState("linear")?.tokens?.access_token).toBe("oauth-access-token-2");

    // If a subsequent re-authorization fails/denies, the prior valid session is restored.
    failBrowserLogin = true;
    await expect(oauth.authorizeServer("linear", `${baseUrl}/mcp`)).rejects.toThrow(/access_denied/);
    expect(credentials.getOAuthState("linear")?.tokens?.access_token).toBe("oauth-access-token-2");

    // Runtime provider exposes saved tokens and fails loudly if interactive login is ever needed.
    const runtimeProvider = oauth.createRuntimeProvider("linear");
    expect(await runtimeProvider.tokens()).toMatchObject({ access_token: "oauth-access-token-2" });
    expect(() => runtimeProvider.redirectToAuthorization(new URL("https://example.test/auth"))).toThrow(
      /Sign in with OAuth/i,
    );

    oauth.revokeServer("linear");
    expect(credentials.getOAuthStatus("linear")).toEqual({ status: "none" });
  });
});
