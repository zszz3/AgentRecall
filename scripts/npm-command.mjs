import { existsSync } from "node:fs";
import path from "node:path";

function quoteWindowsCmdExecutable(command) {
  const text = String(command);
  if (/[\r\n\0"]/u.test(text)) {
    throw new Error("Command executable path on Windows cannot contain quotes, newlines, or NUL bytes.");
  }
  return `"${text.replace(/%/g, '"^%"')}"`;
}

export function quoteWindowsCmdArg(arg) {
  const text = String(arg);
  if (/[\r\n\0]/u.test(text)) {
    throw new Error("Command arguments on Windows cannot contain newlines or NUL bytes.");
  }
  let msvcr = '"';
  let backslashes = 0;
  for (const ch of text) {
    if (ch === "\\") {
      backslashes += 1;
    } else if (ch === '"') {
      msvcr += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
    } else {
      msvcr += `${"\\".repeat(backslashes)}${ch}`;
      backslashes = 0;
    }
  }
  msvcr += `${"\\".repeat(backslashes * 2)}"`;

  // Batch (.cmd/.bat) %* expansion parses the command line twice on cmd.exe.
  const escapeCmdMeta = (value) => value.replace(/[()%!^"<>&|]/g, "^$&");
  return escapeCmdMeta(escapeCmdMeta(msvcr));
}

export function resolveNpmInvocation(args, environment = process.env, platform = process.platform) {
  if (platform !== "win32") {
    return { command: "npm", args: [...args], windowsVerbatimArguments: false };
  }
  const envNpmExecPath = environment.npm_execpath?.trim();
  const adjacentNpmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npmCli = (envNpmExecPath && /(?:^|[\\/])npm-cli\.js$/iu.test(envNpmExecPath) && existsSync(envNpmExecPath) && envNpmExecPath)
    || (existsSync(adjacentNpmCli) && adjacentNpmCli)
    || null;
  if (npmCli) {
    return { command: process.execPath, args: [npmCli, ...args], windowsVerbatimArguments: false };
  }
  const comspec = environment.ComSpec || environment.comspec || "cmd.exe";
  const commandLine = `"${[quoteWindowsCmdExecutable("npm.cmd"), ...args.map(quoteWindowsCmdArg)].join(" ")}"`;
  return { command: comspec, args: ["/d", "/v:off", "/s", "/c", commandLine], windowsVerbatimArguments: true };
}
