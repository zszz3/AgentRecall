import { sessionSourceDescriptor } from "../session-sources";
import type { SessionSearchResult, SessionSource } from "../types";
import {
  escapeAppleScript,
  runProcess,
  runProcessIgnoringExit,
  type ProcessRunner,
} from "./shell-quoting";

export interface RevealCommand {
  file: string;
  args: string[];
  // explorer.exe returns a non-zero exit code even when it succeeds, so its
  // exit status must not be treated as a failure.
  ignoreExitCode: boolean;
}

function sourceDisplayName(source: SessionSource): string {
  return sessionSourceDescriptor(source).label;
}

export async function resolveMacApplicationName(names: string[], runner: ProcessRunner = runProcess): Promise<string | null> {
  for (const name of names) {
    try {
      await runner("/usr/bin/osascript", ["-e", `id of application "${escapeAppleScript(name)}"`]);
      return name;
    } catch {
      // Try the next commonly registered app name.
    }
  }
  return null;
}

export async function openNativeApp(
  session: Pick<SessionSearchResult, "source" | "rawId">,
  options: {
    platform?: NodeJS.Platform;
    openExternal?: (url: string) => Promise<unknown>;
    runProcess?: ProcessRunner;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (session.source === "codex-app") {
    if (platform !== "darwin" && platform !== "win32") {
      throw new Error(`Opening Codex App sessions is not supported on ${platform}.`);
    }
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(session.rawId)) {
      throw new Error("The Codex App task ID is not a valid UUID.");
    }
    if (!options.openExternal) throw new Error("No system URL opener is available for Codex App sessions.");
    await options.openExternal(`codex://threads/${encodeURIComponent(session.rawId)}`);
    return;
  }

  const family = sessionSourceDescriptor(session.source).nativeAppFamily;
  if (!family) {
    throw new Error(`Native app opening is not configured for ${sourceDisplayName(session.source)} sessions yet.`);
  }
  const appName = family === "claude" ? "Claude" : family === "codebuddy" ? "CodeBuddy CN" : "Codex";
  if (platform === "darwin") {
    await (options.runProcess ?? runProcess)("/usr/bin/open", ["-a", appName]);
  }
}

export function buildRevealCommand(targetPath: string, platform: NodeJS.Platform = process.platform): RevealCommand {
  if (platform === "darwin") return { file: "/usr/bin/open", args: ["-R", targetPath], ignoreExitCode: false };
  if (platform === "win32") {
    // `explorer.exe <path>` opens the item; `/select,<path>` reveals it inside
    // its parent folder (matching `open -R`). Explorer needs backslashes.
    const winPath = targetPath.replace(/\//g, "\\");
    return { file: "explorer.exe", args: [`/select,${winPath}`], ignoreExitCode: true };
  }
  return { file: "xdg-open", args: [targetPath], ignoreExitCode: false };
}

export async function revealInFileManager(targetPath: string): Promise<void> {
  if (!targetPath) return;
  const { file, args, ignoreExitCode } = buildRevealCommand(targetPath);
  if (ignoreExitCode) {
    await runProcessIgnoringExit(file, args);
    return;
  }
  await runProcess(file, args);
}
