import { describe, expect, it } from "vitest";
import {
  McpCredentialService,
  type McpCredentialBackingStore,
  type McpCredentialEncryption,
} from "./mcp-credential-service";

function createTestCredentials(available = true) {
  const data: Record<string, unknown> = {};
  const store: McpCredentialBackingStore = {
    get: ((key: string) => data[key]) as McpCredentialBackingStore["get"],
    set: ((key: string, value: unknown) => { data[key] = value; }) as McpCredentialBackingStore["set"],
  };
  const encryption: McpCredentialEncryption = {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buf) => {
      const text = buf.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("corrupt");
      return text.slice(4);
    },
  };
  return { service: new McpCredentialService(store, encryption), data };
}

describe("McpCredentialService", () => {
  it("encrypts, lists key names only, resolves in main process, and deletes secrets", () => {
    const { service, data } = createTestCredentials();

    service.setSecret("srv-1", "env", "GITHUB_TOKEN", "ghp_secret_123");
    service.setSecret("srv-1", "header", "Authorization", "Bearer top-secret");

    // Backing store never holds plaintext values.
    expect(JSON.stringify(data)).not.toContain("ghp_secret_123");
    expect(JSON.stringify(data)).not.toContain("top-secret");

    expect(service.listSecretKeys("srv-1")).toEqual({
      envKeys: ["GITHUB_TOKEN"],
      headerKeys: ["Authorization"],
    });
    expect(service.resolveSecrets("srv-1")).toEqual({
      env: { GITHUB_TOKEN: "ghp_secret_123" },
      headers: { Authorization: "Bearer top-secret" },
    });

    service.deleteSecret("srv-1", "env", "GITHUB_TOKEN");
    expect(service.listSecretKeys("srv-1")).toEqual({
      envKeys: [],
      headerKeys: ["Authorization"],
    });

    service.deleteAllForServer("srv-1");
    expect(service.resolveSecrets("srv-1")).toEqual({ env: {}, headers: {} });
  });

  it("persists encrypted OAuth state and exposes only non-secret status", () => {
    const { service, data } = createTestCredentials();

    expect(service.getOAuthStatus("notion")).toEqual({ status: "none" });
    service.saveOAuthState("notion", (current) => ({
      ...current,
      tokens: {
        access_token: "at_live_secret",
        refresh_token: "rt_live_secret",
        token_type: "bearer",
        scope: "read write",
      },
      updatedAt: 123_456,
    }));

    expect(JSON.stringify(data)).not.toContain("at_live_secret");
    expect(service.getOAuthStatus("notion")).toEqual({
      status: "authorized",
      scope: "read write",
      updatedAt: 123_456,
    });

    service.clearOAuthState("notion", "tokens");
    expect(service.getOAuthStatus("notion")).toEqual({ status: "none" });
  });

  it("fails loudly when OS credential encryption is unavailable", () => {
    const { service } = createTestCredentials(false);
    expect(() => service.setSecret("srv", "env", "KEY", "val")).toThrow(/unavailable/i);
  });
});
