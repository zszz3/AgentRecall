import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Client, ConnectConfig } from "ssh2";
import { SshCommandService } from "./ssh-command-service";
import type { SessionEnvironment } from "../../core/types";

class FakeChannel extends PassThrough {
  readonly stderr = new PassThrough();

  override end(): this {
    queueMicrotask(() => {
      this.emit("data", Buffer.from("remote output"));
      this.emit("exit", 0);
      this.emit("close");
    });
    return this;
  }

  close(): void {
    this.emit("close");
  }
}

class FakeClient extends EventEmitter {
  readonly channel = new FakeChannel();
  config: ConnectConfig | null = null;
  command: string | null = null;
  keyboardAnswers: string[] = [];
  ended = false;

  connect(config: ConnectConfig): this {
    this.config = config;
    queueMicrotask(() => {
      this.emit(
        "keyboard-interactive",
        "",
        "",
        "",
        [{ prompt: "Password:", echo: false }],
        (answers: string[]) => {
          this.keyboardAnswers = answers;
        },
      );
      const verified = (config.hostVerifier as (key: Buffer) => boolean)(Buffer.from("trusted-key"));
      if (verified) this.emit("ready");
      else this.emit("error", new Error("Host denied (verification failed)"));
    });
    return this;
  }

  exec(command: string, callback: (error: Error | undefined, channel: FakeChannel) => void): this {
    this.command = command;
    callback(undefined, this.channel);
    return this;
  }

  end(): this {
    this.ended = true;
    return this;
  }
}

function passwordEnvironment(): SessionEnvironment {
  return {
    id: "ssh-1",
    kind: "ssh",
    label: "Remote",
    hostAlias: null,
    host: "example.com",
    user: "alice",
    port: 2222,
    authMode: "password",
    identityFile: null,
    enabled: true,
    syncState: "idle",
    lastSyncedAt: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("SshCommandService", () => {
  it("runs a command with the saved password and a trusted host key", async () => {
    const client = new FakeClient();
    const service = new SshCommandService({
      getPassword: () => " secret ",
      createClient: () => client as unknown as Client,
      loadKnownHostKeys: async () => new Set([Buffer.from("trusted-key").toString("base64")]),
    });

    await expect(service.run(passwordEnvironment(), "echo ok")).resolves.toBe("remote output");

    expect(client.config).toMatchObject({
      host: "example.com",
      port: 2222,
      username: "alice",
      password: " secret ",
      tryKeyboard: true,
    });
    expect(client.keyboardAnswers).toEqual([" secret "]);
    expect(client.command).toBe("echo ok");
    expect(client.ended).toBe(true);
  });

  it("refuses unknown hosts before sending a password", async () => {
    const createClient = vi.fn(() => new FakeClient() as unknown as Client);
    const service = new SshCommandService({
      getPassword: () => "secret",
      createClient,
      loadKnownHostKeys: async () => new Set(),
    });

    await expect(service.run(passwordEnvironment(), "echo ok")).rejects.toThrow(
      /host key for example\.com:2222 is not trusted/i,
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("requires both a username and a saved password", async () => {
    const service = new SshCommandService({
      getPassword: () => null,
      loadKnownHostKeys: async () => new Set(["unused"]),
    });

    await expect(
      service.run({ ...passwordEnvironment(), user: null }, "echo ok"),
    ).rejects.toThrow(/username is required/i);
    await expect(service.run(passwordEnvironment(), "echo ok")).rejects.toThrow(/No saved SSH password/);
  });
});
