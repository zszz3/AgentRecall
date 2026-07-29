import { describe, expect, it } from "vitest";
import { SshCredentialService } from "./ssh-credential-service";
import type { EnvironmentUpsertInput, SessionEnvironment } from "../../core/types";

function sshEnvironment(authMode: SessionEnvironment["authMode"] = "password"): SessionEnvironment {
  return {
    id: "ssh-1",
    kind: "ssh",
    label: "Remote",
    hostAlias: null,
    host: "example.com",
    user: "alice",
    port: 22,
    authMode,
    identityFile: null,
    enabled: true,
    syncState: "idle",
    lastSyncedAt: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createHarness(encryptionAvailable = true) {
  let passwords: Record<string, string> = {};
  const service = new SshCredentialService(
    {
      get: () => passwords,
      set: (_key, value) => {
        passwords = value;
      },
    },
    {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
    },
  );
  return { service, storedPasswords: () => passwords };
}

describe("SshCredentialService", () => {
  it("encrypts passwords before persisting and decrypts them for connections", () => {
    const { service, storedPasswords } = createHarness();
    const input: EnvironmentUpsertInput = { kind: "ssh", label: "Remote", password: "secret value" };

    service.saveForEnvironment(sshEnvironment(), input);

    expect(storedPasswords()["ssh-1"]).not.toContain("secret value");
    expect(service.getPassword("ssh-1")).toBe("secret value");
  });

  it("keeps an existing password when an update omits it", () => {
    const { service } = createHarness();
    service.saveForEnvironment(sshEnvironment(), { kind: "ssh", label: "Remote", password: "secret" });

    expect(() => service.saveForEnvironment(sshEnvironment(), { kind: "ssh", label: "Remote" })).not.toThrow();
    expect(service.getPassword("ssh-1")).toBe("secret");
  });

  it("removes credentials when authentication mode changes", () => {
    const { service, storedPasswords } = createHarness();
    service.saveForEnvironment(sshEnvironment(), { kind: "ssh", label: "Remote", password: "secret" });

    service.saveForEnvironment(sshEnvironment("none"), { kind: "ssh", label: "Remote" });

    expect(storedPasswords()).toEqual({});
  });

  it("fails instead of storing plaintext when encryption is unavailable", () => {
    const { service, storedPasswords } = createHarness(false);

    expect(() =>
      service.saveForEnvironment(sshEnvironment(), { kind: "ssh", label: "Remote", password: "secret" }),
    ).toThrow(/Secure password storage is unavailable/);
    expect(storedPasswords()).toEqual({});
  });
});
