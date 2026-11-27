import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpOAuthStatus, McpSecretKind } from "../../automation/engine/shared/mcp/types";

export interface McpStoredOAuthState {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  updatedAt?: number;
}

export interface McpCredentialBackingStore {
  get(key: "secrets"): Record<string, { env?: Record<string, string>; header?: Record<string, string> }> | undefined;
  set(key: "secrets", value: Record<string, { env?: Record<string, string>; header?: Record<string, string> }>): void;
  get(key: "oauth"): Record<string, string> | undefined;
  set(key: "oauth", value: Record<string, string>): void;
}

export interface McpCredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface ResolvedMcpSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

export class McpCredentialService {
  constructor(
    private readonly store: McpCredentialBackingStore,
    private readonly encryption: McpCredentialEncryption,
  ) {}

  setSecret(serverId: string, kind: McpSecretKind, key: string, value: string): void {
    const trimmedKey = key.trim();
    if (!trimmedKey) throw new Error("Secret key name is required.");
    if (!value) throw new Error("Secret value is required.");
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system.");
    }
    const all = this.readSecretMap();
    const bucket = {
      ...(all[serverId] ?? {}),
      [kind]: { ...(all[serverId]?.[kind] ?? {}) },
    };
    bucket[kind]![trimmedKey] = this.encryption.encryptString(value).toString("base64");
    all[serverId] = bucket;
    this.store.set("secrets", all);
  }

  deleteSecret(serverId: string, kind: McpSecretKind, key: string): void {
    const all = this.readSecretMap();
    const bucket = all[serverId];
    if (!bucket?.[kind] || !(key in bucket[kind]!)) return;
    const nextKind = { ...bucket[kind]! };
    delete nextKind[key];
    const nextBucket = { ...bucket, [kind]: nextKind };
    if (Object.keys(nextBucket.env ?? {}).length === 0) delete nextBucket.env;
    if (Object.keys(nextBucket.header ?? {}).length === 0) delete nextBucket.header;
    if (!nextBucket.env && !nextBucket.header) delete all[serverId];
    else all[serverId] = nextBucket;
    this.store.set("secrets", all);
  }

  listSecretKeys(serverId: string): { envKeys: string[]; headerKeys: string[] } {
    const bucket = this.readSecretMap()[serverId];
    return {
      envKeys: Object.keys(bucket?.env ?? {}).sort((left, right) => left.localeCompare(right)),
      headerKeys: Object.keys(bucket?.header ?? {}).sort((left, right) => left.localeCompare(right)),
    };
  }

  resolveSecrets(serverId: string): ResolvedMcpSecrets {
    const bucket = this.readSecretMap()[serverId];
    if (!bucket) return { env: {}, headers: {} };
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system.");
    }
    const decodeRecord = (source?: Record<string, string>): Record<string, string> => {
      if (!source) return {};
      const out: Record<string, string> = {};
      for (const [key, encoded] of Object.entries(source)) {
        try {
          out[key] = this.encryption.decryptString(Buffer.from(encoded, "base64"));
        } catch {
          throw new Error(`Saved MCP secret "${key}" could not be decrypted. Save it again.`);
        }
      }
      return out;
    };
    return {
      env: decodeRecord(bucket.env),
      headers: decodeRecord(bucket.header),
    };
  }

  getOAuthState(serverId: string): McpStoredOAuthState | undefined {
    const encoded = this.readOAuthMap()[serverId];
    if (!encoded) return undefined;
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system.");
    }
    try {
      const parsed = JSON.parse(this.encryption.decryptString(Buffer.from(encoded, "base64"))) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as McpStoredOAuthState)
        : undefined;
    } catch {
      throw new Error("Saved MCP OAuth session could not be decrypted. Sign in again.");
    }
  }

  saveOAuthState(serverId: string, updater: (current: McpStoredOAuthState) => McpStoredOAuthState): void {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system.");
    }
    let current: McpStoredOAuthState = {};
    try {
      current = this.getOAuthState(serverId) ?? {};
    } catch {
      current = {};
    }
    const next = updater(current);
    const all = this.readOAuthMap();
    all[serverId] = this.encryption.encryptString(JSON.stringify(next)).toString("base64");
    this.store.set("oauth", all);
  }

  clearOAuthState(serverId: string, scope: "all" | "client" | "tokens" | "verifier" | "discovery" = "all"): void {
    const all = this.readOAuthMap();
    if (!(serverId in all)) return;
    if (scope === "all") {
      delete all[serverId];
      this.store.set("oauth", all);
      return;
    }
    this.saveOAuthState(serverId, (current) => {
      const next = { ...current };
      if (scope === "client") delete next.clientInformation;
      if (scope === "tokens") delete next.tokens;
      if (scope === "verifier") delete next.codeVerifier;
      if (scope === "discovery") delete next.discoveryState;
      return next;
    });
  }

  getOAuthStatus(serverId: string): McpOAuthStatus {
    try {
      const state = this.getOAuthState(serverId);
      if (state?.tokens?.access_token) {
        return {
          status: "authorized",
          ...(state.tokens.scope ? { scope: state.tokens.scope } : {}),
          ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
        };
      }
    } catch {
      // Encrypted entry unreadable -> report unauthenticated so user can re-sign-in.
    }
    return { status: "none" };
  }

  deleteAllForServer(serverId: string): void {
    const secrets = this.readSecretMap();
    if (serverId in secrets) {
      delete secrets[serverId];
      this.store.set("secrets", secrets);
    }
    const oauth = this.readOAuthMap();
    if (serverId in oauth) {
      delete oauth[serverId];
      this.store.set("oauth", oauth);
    }
  }

  private readSecretMap(): Record<string, { env?: Record<string, string>; header?: Record<string, string> }> {
    return { ...(this.store.get("secrets") ?? {}) };
  }

  private readOAuthMap(): Record<string, string> {
    return { ...(this.store.get("oauth") ?? {}) };
  }
}
