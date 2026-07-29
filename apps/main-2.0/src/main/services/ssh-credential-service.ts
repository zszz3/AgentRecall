import type { EnvironmentUpsertInput, SessionEnvironment } from "../../core/types";

export interface SshCredentialBackingStore {
  get(key: "passwords"): Record<string, string> | undefined;
  set(key: "passwords", value: Record<string, string>): void;
}

export interface SshCredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class SshCredentialService {
  constructor(
    private readonly store: SshCredentialBackingStore,
    private readonly encryption: SshCredentialEncryption,
  ) {}

  saveForEnvironment(environment: SessionEnvironment, input: EnvironmentUpsertInput): void {
    if (environment.kind !== "ssh" || environment.authMode !== "password") {
      this.deletePassword(environment.id);
      return;
    }

    if (input.password == null) {
      if (this.getPassword(environment.id) !== null) return;
      throw new Error("SSH password is required.");
    }
    if (!input.password) throw new Error("SSH password is required.");
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error("Secure password storage is unavailable on this system.");
    }

    const passwords = this.readPasswords();
    passwords[environment.id] = this.encryption.encryptString(input.password).toString("base64");
    this.store.set("passwords", passwords);
  }

  getPassword(environmentId: string): string | null {
    const encoded = this.readPasswords()[environmentId];
    if (!encoded) return null;
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error("Secure password storage is unavailable on this system.");
    }
    try {
      return this.encryption.decryptString(Buffer.from(encoded, "base64"));
    } catch {
      throw new Error("The saved SSH password could not be decrypted. Save the connection again.");
    }
  }

  deletePassword(environmentId: string): void {
    const passwords = this.readPasswords();
    if (!(environmentId in passwords)) return;
    delete passwords[environmentId];
    this.store.set("passwords", passwords);
  }

  private readPasswords(): Record<string, string> {
    return { ...(this.store.get("passwords") ?? {}) };
  }
}
