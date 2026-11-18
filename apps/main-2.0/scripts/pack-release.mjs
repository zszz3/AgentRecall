import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function quoteWindowsCmdExecutable(command) {
  const text = String(command);
  if (/[\r\n\0"]/u.test(text)) {
    throw new Error("Command executable path on Windows cannot contain quotes, newlines, or NUL bytes.");
  }
  return `"${text.replace(/%/g, '"^%"')}"`;
}

function quoteWindowsCmdArg(arg) {
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

function parsePackResult(stdout) {
  const lines = String(stdout).trim().split("\n");
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    try {
      const result = JSON.parse(lines.slice(start).join("\n"));
      const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
      if (packed?.filename) return packed;
    } catch {
      // npm lifecycle scripts can write build logs before the final JSON result.
    }
  }
  throw new Error("npm pack did not return a JSON package result.");
}

export async function packReleaseArchive({ root, destination, environment = process.env }) {
  await mkdir(destination, { recursive: true });
  const npm = resolveNpmInvocation(["pack", "--pack-destination", destination, "--json"], environment);
  let stdout;
  try {
    ({ stdout } = await execFile(npm.command, npm.args, {
      cwd: root,
      env: environment,
      shell: false,
      windowsHide: true,
      ...(npm.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    }));
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error && error.stderr
      ? String(error.stderr).trim()
      : error instanceof Error ? error.message : String(error);
    throw new Error(`npm pack failed: ${detail}`);
  }
  const packed = parsePackResult(stdout);
  const bundledMcpSourceMap = packed.files?.find(({ path: filePath }) =>
    filePath.startsWith("out/mcp/") && filePath.endsWith(".map"));
  if (bundledMcpSourceMap) {
    throw new Error(`Release package must not include MCP source maps: ${bundledMcpSourceMap.path}`);
  }
  return path.join(destination, packed.filename);
}

async function runCli(args) {
  const destinationIndex = args.indexOf("--pack-destination");
  const destination = destinationIndex >= 0 ? args[destinationIndex + 1] : undefined;
  const archive = await packReleaseArchive({
    root: process.cwd(),
    destination: destination || process.cwd(),
  });
  process.stdout.write(`${path.basename(archive)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
