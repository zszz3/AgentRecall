import { execFile } from "node:child_process";
import { Client, type ClientChannel, type ConnectConfig, type Prompt } from "ssh2";
import { buildRemoteSyncSshArgs, formatRemoteSyncProcessError } from "../../core/remote-sync";
import { buildRemoteWatchCommand, startSystemWatcher, type WatchHandle } from "../../core/remote-watch";
import type { SessionEnvironment } from "../../core/types";

export interface SshCommandOptions {
  input?: string;
  timeout?: number;
  maxBuffer?: number;
}

export interface SshCommandServiceOptions {
  getPassword: (environmentId: string) => string | null;
  createClient?: () => Client;
  loadKnownHostKeys?: (host: string, port: number) => Promise<Set<string>>;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_BUFFER = 128 * 1024 * 1024;

export class SshCommandService {
  private readonly getPassword: (environmentId: string) => string | null;
  private readonly createClient: () => Client;
  private readonly loadKnownHostKeys: (host: string, port: number) => Promise<Set<string>>;

  constructor(options: SshCommandServiceOptions) {
    this.getPassword = options.getPassword;
    this.createClient = options.createClient ?? (() => new Client());
    this.loadKnownHostKeys = options.loadKnownHostKeys ?? loadKnownHostKeys;
  }

  run(environment: SessionEnvironment, remoteCommand: string, options: SshCommandOptions = {}): Promise<string> {
    if (environment.kind !== "ssh") throw new Error("SSH command service requires an SSH environment.");
    if (environment.authMode !== "password") return runSystemSsh(environment, remoteCommand, options);
    return this.runWithPassword(environment, remoteCommand, options);
  }

  watch(
    environment: SessionEnvironment,
    onEvent: () => void,
    onUnavailable?: () => void,
  ): WatchHandle {
    if (environment.kind !== "ssh" || environment.authMode !== "password") {
      return startSystemWatcher(environment, onEvent, onUnavailable);
    }

    let stopped = false;
    let client: Client | null = null;
    let channel: ClientChannel | null = null;
    let reportedUnavailable = false;
    const reportUnavailable = (): void => {
      if (stopped || reportedUnavailable) return;
      reportedUnavailable = true;
      onUnavailable?.();
    };

    void this.connectWithPassword(environment)
      .then(({ client: connectedClient, config }) => {
        if (stopped) {
          connectedClient.end();
          return;
        }
        client = connectedClient;
        installPasswordAuthentication(client, config.password ?? "");
        client.once("error", reportUnavailable);
        client.once("close", reportUnavailable);
        client.once("ready", () => {
          client?.exec(buildRemoteWatchCommand(), (error, stream) => {
            if (error) {
              reportUnavailable();
              client?.end();
              return;
            }
            if (stopped) {
              stream.close();
              client?.end();
              return;
            }
            channel = stream;
            stream.on("data", onEvent);
            stream.stderr.on("data", () => undefined);
            stream.once("close", reportUnavailable);
          });
        });
        client.connect(config);
      })
      .catch(reportUnavailable);

    return {
      stop: () => {
        stopped = true;
        channel?.close();
        client?.end();
      },
    };
  }

  private async runWithPassword(
    environment: SessionEnvironment,
    remoteCommand: string,
    options: SshCommandOptions,
  ): Promise<string> {
    const { client, config } = await this.connectWithPassword(environment, options.timeout);
    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let channel: ClientChannel | null = null;
      let stdoutSize = 0;
      let stderrSize = 0;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.end();
        if (error) {
          reject(error);
          return;
        }
        const stderrText = Buffer.concat(stderr).toString("utf8").trim();
        if (exitCode !== null && exitCode !== 0) {
          reject(new Error(`SSH command failed with exit code ${exitCode}${stderrText ? `: ${stderrText}` : "."}`));
          return;
        }
        if (exitSignal) {
          reject(new Error(`SSH command was terminated by signal ${exitSignal}${stderrText ? `: ${stderrText}` : "."}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      };

      const timer = setTimeout(() => finish(new Error(`SSH command timed out after ${timeoutMs} ms.`)), timeoutMs);
      installPasswordAuthentication(client, config.password ?? "");
      client.once("error", (error) => finish(new Error(formatConnectionError(environment, error))));
      client.once("close", () => finish(new Error("SSH connection closed before the command completed.")));
      client.once("ready", () => {
        client.exec(remoteCommand, (error, stream) => {
          if (error) {
            finish(error);
            return;
          }
          channel = stream;
          stream.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            stdoutSize += buffer.length;
            if (stdoutSize + stderrSize > maxBuffer) {
              finish(new Error(`SSH command output exceeded ${maxBuffer} bytes.`));
              return;
            }
            stdout.push(buffer);
          });
          stream.stderr.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            stderrSize += buffer.length;
            if (stdoutSize + stderrSize > maxBuffer) {
              finish(new Error(`SSH command output exceeded ${maxBuffer} bytes.`));
              return;
            }
            stderr.push(buffer);
          });
          stream.on("exit", (code: number | null, signal?: string) => {
            exitCode = code;
            exitSignal = signal ?? null;
          });
          stream.once("error", (error: Error) => finish(error));
          stream.once("close", (...args: unknown[]) => {
            if (exitCode === null && typeof args[0] === "number") exitCode = args[0];
            if (!exitSignal && typeof args[1] === "string") exitSignal = args[1];
            finish();
          });
          stream.end(options.input);
        });
      });
      client.connect(config);
    });
  }

  private async connectWithPassword(
    environment: SessionEnvironment,
    timeout = DEFAULT_TIMEOUT_MS,
  ): Promise<{ client: Client; config: ConnectConfig }> {
    const host = environment.host?.trim();
    const username = environment.user?.trim();
    if (!host) throw new Error("SSH host is required for password authentication.");
    if (!username) throw new Error("SSH username is required for password authentication.");
    const password = this.getPassword(environment.id);
    if (password === null) throw new Error("No saved SSH password was found. Save the connection again.");
    const port = environment.port ?? 22;
    const trustedKeys = await this.loadKnownHostKeys(host, port);
    if (trustedKeys.size === 0) throw untrustedHostError(host, port);

    return {
      client: this.createClient(),
      config: {
        host,
        port,
        username,
        password,
        tryKeyboard: true,
        readyTimeout: timeout,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => trustedKeys.has(key.toString("base64")),
      },
    };
  }
}

function installPasswordAuthentication(client: Client, password: string): void {
  client.on(
    "keyboard-interactive",
    (_name: string, _instructions: string, _language: string, prompts: Prompt[], finish) => {
      finish(prompts.map((prompt) => (prompt.echo ? "" : password)));
    },
  );
}

function runSystemSsh(
  environment: SessionEnvironment,
  remoteCommand: string,
  options: SshCommandOptions,
): Promise<string> {
  const args = buildRemoteSyncSshArgs(environment, remoteCommand);
  return new Promise((resolve, reject) => {
    const child = execFile(
      "ssh",
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(formatRemoteSyncProcessError(error, stdout, stderr)));
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.end(options.input);
  });
}

function loadKnownHostKeys(host: string, port: number): Promise<Set<string>> {
  const lookupHost = port === 22 ? host : `[${host}]:${port}`;
  return new Promise((resolve, reject) => {
    execFile("ssh-keygen", ["-F", lookupHost], { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error && "code" in error && error.code === 1) {
        resolve(new Set());
        return;
      }
      if (error) {
        reject(new Error(String(stderr).trim() || error.message));
        return;
      }
      const keys = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const fields = trimmed.split(/\s+/);
        if (fields[2]) keys.add(fields[2]);
      }
      resolve(keys);
    });
  });
}

function untrustedHostError(host: string, port: number): Error {
  const destination = port === 22 ? host : `${host}:${port}`;
  return new Error(
    `SSH host key for ${destination} is not trusted. Connect once with the system ssh command to verify it, then retry.`,
  );
}

function formatConnectionError(environment: SessionEnvironment, error: Error): string {
  if (/host key|verification/i.test(error.message)) return untrustedHostError(environment.host ?? "", environment.port ?? 22).message;
  return error.message;
}
