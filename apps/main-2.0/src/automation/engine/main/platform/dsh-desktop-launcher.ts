import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const which = require("which") as {
  sync(command: string, options: { path?: string; nothrow: true }): string | null;
};

/** Resolve the desktop CLI only when the default command is absent from PATH. */
export function resolveDshDesktopInvocation(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): { executable: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
  if (process.platform !== "darwin" || executable !== "dsh") return undefined;
  if (which.sync(executable, { path: environment.PATH ?? "", nothrow: true })) return undefined;

  const home = environment.HOME || os.homedir();
  for (const applications of [path.join(home, "Applications"), "/Applications"]) {
    const contents = path.join(applications, "DeepSeek Harness.app", "Contents");
    const binary = path.join(contents, "MacOS", "DeepSeek Harness");
    const archive = path.join(contents, "Resources", "app.asar");
    if (!existsSync(binary) || !existsSync(archive)) continue;
    return {
      executable: binary,
      args: [path.join(archive, "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), ...args],
      env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return undefined;
}
