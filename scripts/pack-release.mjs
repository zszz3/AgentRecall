import { execFile as execFileCallback } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

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
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await execFile(npm, ["pack", "--pack-destination", destination, "--json"], {
    cwd: root,
    env: environment,
    shell: process.platform === "win32",
  });
  const packed = parsePackResult(stdout);
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
