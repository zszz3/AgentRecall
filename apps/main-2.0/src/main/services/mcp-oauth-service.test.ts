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
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({
            client_id: "dyn-client-1",
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
          if (params.get("code") !== "auth-code-xyz") {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            access_token: "oauth-access-token-1",
            refresh_token: "oauth-refresh-token-1",
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

    const credentials = createCredentials();
    const oauth = new McpOAuthService({
      credentials,
      timeoutMs: 10_000,
      openExternal: async (authorizationUrl) => {
        // Simulate browser visiting the authorization endpoint and redirecting back to AgentRecall's callback.
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri")!;
        const state = parsed.searchParams.get("state")!;
        const callbackResponse = await fetch(`${redirectUri}?code=auth-code-xyz&state=${encodeURIComponent(state)}`);
        expect(callbackResponse.status).toBe(200);
      },
    });
    services.push(oauth);

    const status = await oauth.authorizeServer("linear", `${baseUrl}/mcp`);
    expect(status).toMatchObject({ status: "authorized", scope: "mcp:read" });
    expect(credentials.getOAuthState("linear")?.tokens?.access_token).toBe("oauth-access-token-1");

    // Runtime provider exposes saved tokens and fails loudly if interactive login is ever needed.
    const runtimeProvider = oauth.createRuntimeProvider("linear");
    expect(await runtimeProvider.tokens()).toMatchObject({ access_token: "oauth-access-token-1" });
    expect(() => runtimeProvider.redirectToAuthorization(new URL("https://example.test/auth"))).toThrow(
      /Sign in with OAuth/i,
    );

    oauth.revokeServer("linear");
    expect(credentials.getOAuthStatus("linear")).toEqual({ status: "none" });
  });
});
