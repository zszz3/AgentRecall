import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SshAuthMode } from "./types";

export interface SshConfigHost {
  alias: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
}

export interface ManualSshInput {
  label: string;
  host: string;
  user?: string;
  port: string;
  authMode: SshAuthMode;
  identityFile: string;
  password?: string;
}

export interface NormalizedManualSshInput {
  label: string;
  host: string;
  user: string | null;
  port: number | null;
  authMode: SshAuthMode;
  identityFile: string | null;
  password: string | null;
}

export interface SshTarget {
  hostAlias: string | null;
  host: string | null;
  user: string | null;
  port: number | null;
  authMode: SshAuthMode;
  identityFile: string | null;
}

export function readUserSshConfig(configPath = path.join(os.homedir(), ".ssh", "config")): SshConfigHost[] {
  try {
    return parseSshConfigHosts(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return [];
  }
}

export function parseSshConfigHosts(content: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  const seenAliases = new Set<string>();
  let aliases: string[] = [];
  let block: Omit<SshConfigHost, "alias"> = emptyBlock();

  const flush = (): void => {
    for (const alias of aliases) {
      if (isConcreteAlias(alias) && !seenAliases.has(alias)) {
        seenAliases.add(alias);
        hosts.push({ alias, ...block });
      }
    }
    aliases = [];
    block = emptyBlock();
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const [rawKey, ...rest] = normalizeSshConfigTokens(tokenizeSshConfigLine(rawLine));
    if (!rawKey) continue;
    const key = rawKey.toLowerCase();
    const value = rest.join(" ");
    if (key === "host") {
      flush();
      aliases = rest;
      continue;
    }
    if (key === "match") {
      flush();
      continue;
    }
    if (aliases.length === 0) continue;
    if (key === "hostname") block.hostName = value || null;
    else if (key === "user") block.user = value || null;
    else if (key === "port") block.port = parsePort(value);
    else if (key === "identityfile") block.identityFile = value || null;
  }
  flush();
  return hosts;
}

export function normalizeManualSshInput(input: ManualSshInput): NormalizedManualSshInput {
  const rawHost = input.host.trim();
  const at = rawHost.lastIndexOf("@");
  const embeddedUser = at >= 0 ? rawHost.slice(0, at).trim() || null : null;
  const user = input.user?.trim() || embeddedUser;
  const host = at >= 0 ? rawHost.slice(at + 1).trim() : rawHost;
  const port = parseManualPort(input.port.trim());
  const label = input.label.trim() || host;
  return {
    label,
    host,
    user,
    port,
    authMode: input.authMode,
    identityFile: input.authMode === "identityFile" ? input.identityFile.trim() || null : null,
    password: input.authMode === "password" ? input.password || null : null,
  };
}

export function buildSshArgs(target: SshTarget, remoteCommand: string): string[] {
  if (target.hostAlias) return ["--", target.hostAlias, remoteCommand];
  if (!target.host) throw new Error("SSH host is required.");
  const args: string[] = [];
  if (target.authMode === "identityFile" && target.identityFile) args.push("-i", target.identityFile);
  if (target.authMode === "password") {
    args.push(
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PubkeyAuthentication=no",
    );
  }
  if (target.port) args.push("-p", String(target.port));
  args.push("--");
  args.push(target.user ? `${target.user}@${target.host}` : target.host);
  args.push(remoteCommand);
  return args;
}

function tokenizeSshConfigLine(rawLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;

  for (let index = 0; index < rawLine.length; index += 1) {
    const char = rawLine[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && index + 1 < rawLine.length) {
        index += 1;
        current += rawLine[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "#" && (!tokenStarted || /\s/.test(rawLine[index - 1] ?? ""))) break;

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (tokenStarted) tokens.push(current);
  return tokens;
}

function normalizeSshConfigTokens(tokens: string[]): string[] {
  const [first, ...rest] = tokens;
  if (!first) return [];

  const equals = first.indexOf("=");
  if (equals > 0) {
    const key = first.slice(0, equals);
    const value = first.slice(equals + 1);
    return value ? [key, value, ...rest] : [key, ...rest];
  }

  const [second, ...tail] = rest;
  if (second === "=") return [first, ...tail];
  if (second?.startsWith("=")) return [first, second.slice(1), ...tail];

  return tokens;
}

function emptyBlock(): Omit<SshConfigHost, "alias"> {
  return { hostName: null, user: null, port: null, identityFile: null };
}

function isConcreteAlias(alias: string): boolean {
  return Boolean(alias) && !alias.includes("*") && !alias.includes("?") && !alias.startsWith("!");
}

function parseManualPort(value: string): number | null {
  if (!value) return null;
  const parsed = parsePort(value);
  if (parsed === null) throw new Error("Invalid SSH port.");
  return parsed;
}

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}
