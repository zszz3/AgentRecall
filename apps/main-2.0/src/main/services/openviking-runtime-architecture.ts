import { execFileSync } from "node:child_process";

type RunSysctl = (
  command: string,
  args: readonly string[],
) => string | Buffer;

export function detectRosettaTranslation(
  runSysctl: RunSysctl = (command, args) =>
    execFileSync(command, [...args], { encoding: "utf8" }),
): boolean {
  try {
    return String(runSysctl(
      "/usr/sbin/sysctl",
      ["-in", "sysctl.proc_translated"],
    )).trim() === "1";
  } catch {
    return false;
  }
}

export function resolveOpenVikingRuntimeArchitecture(options: {
  platform?: NodeJS.Platform;
  processArch?: string;
  isRosettaTranslated?: () => boolean;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const processArch = options.processArch ?? process.arch;
  if (
    platform === "darwin"
    && processArch === "x64"
    && (options.isRosettaTranslated ?? detectRosettaTranslation)()
  ) {
    return "arm64";
  }
  return processArch;
}
