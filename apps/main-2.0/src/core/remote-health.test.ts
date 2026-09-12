import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { diagnoseRemoteEnvironment, preflightRemoteSessionResume } from "./remote-health";
import type { SessionEnvironment, SessionSearchResult } from "./types";

const environment: SessionEnvironment = {
  id: "ssh-devbox",
  kind: "ssh",
  label: "devbox",
  hostAlias: "devbox",
  host: null,
  user: null,
  port: null,
  authMode: "none",
  identityFile: null,
  enabled: true,
  syncState: "idle",
  lastSyncedAt: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  environmentId: "ssh-devbox",
  environmentKind: "ssh",
  filePath: "/home/me/.codex/sessions/session.jsonl",
  projectPath: "/work/project",
  source: "codex-cli",
} as SessionSearchResult;

const wslEnvironment: SessionEnvironment = {
  ...environment,
  id: "wsl-ubuntu",
  kind: "wsl",
  label: "WSL · Ubuntu",
  wslDistribution: "Ubuntu",
  hostAlias: null,
  host: null,
};

function decodePythonCommand(command: string): string {
  const match = command.match(/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/);
  if (!match?.[1]) throw new Error("Expected an encoded Python command");
  return inflateRawSync(Buffer.from(match[1], "base64")).toString("utf-8");
}

describe("remote health checks", () => {
  it("checks only Codex and Claude for WSL", async () => {
    const report = await diagnoseRemoteEnvironment(wslEnvironment, {
      runSsh: async (_environment, command) => {
        expect(command).toMatch(/^bash -lc /);
        expect(command).toContain('if [ -s "$HOME/.nvm/nvm.sh" ]');
        return JSON.stringify({
          user: "me",
          codexCli: "/bin/codex",
          claudeCli: "/bin/claude",
          codexSessionsExists: true,
          codexSessionsReadable: true,
          claudeProjectsExists: true,
          claudeProjectsReadable: true,
        });
      },
    });
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      "connectivity", "codex-cli", "claude-cli", "codex-sessions", "claude-projects",
      "tclaude-cli", "tcodex-cli", "codebuddy-cli", "tclaude-projects", "tcodex-sessions", "codebuddy-projects",
    ]);
  });

  it("returns structured health checks for ssh connectivity, CLIs, and session directories", async () => {
    const report = await diagnoseRemoteEnvironment(environment, {
      runSsh: async (_environment, command) => {
        expect(command).toMatch(/^bash -lc /);
        expect(command).toContain("python3 -c");
        return JSON.stringify({
          ok: true,
          home: "/home/me",
          codexCli: "/usr/local/bin/codex",
          claudeCli: null,
          tclaudeCli: "/usr/local/bin/tclaude",
          tcodexCli: null,
          codebuddyCli: "/usr/local/bin/codebuddy",
          codexSessionsExists: true,
          codexSessionsReadable: true,
          claudeProjectsExists: false,
          claudeProjectsReadable: false,
          tclaudeProjectsExists: true,
          tclaudeProjectsReadable: true,
          tcodexSessionsExists: false,
          tcodexSessionsReadable: false,
          codebuddyProjectsExists: true,
          codebuddyProjectsReadable: false,
        });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ["connectivity", "ok"],
      ["codex-cli", "ok"],
      ["claude-cli", "warning"],
      ["codex-sessions", "ok"],
      ["claude-projects", "warning"],
      ["tclaude-cli", "ok"],
      ["tcodex-cli", "warning"],
      ["codebuddy-cli", "ok"],
      ["tclaude-projects", "ok"],
      ["tcodex-sessions", "warning"],
      ["codebuddy-projects", "error"],
    ]);
    expect(report.summary).toContain("6/11");
  });

  it("reports WSL runtime prerequisites, permissions, and safe package hints", async () => {
    const report = await diagnoseRemoteEnvironment(wslEnvironment, {
      runSsh: async () => JSON.stringify({
        user: "me",
        bashPath: "/usr/bin/bash",
        pythonPath: null,
        inotifyPath: null,
        fswatchPath: "/usr/bin/fswatch",
        packageManager: "apt-get",
        homeWritable: false,
        codexCli: "/bin/codex",
        claudeCli: null,
        tclaudeCli: null,
        tcodexCli: null,
        codebuddyCli: null,
        codexSessionsExists: true,
        codexSessionsReadable: true,
        codexSessionsWritable: false,
        claudeProjectsExists: false,
        claudeProjectsReadable: false,
        claudeProjectsWritable: false,
        tclaudeProjectsExists: false,
        tclaudeProjectsReadable: false,
        tclaudeProjectsWritable: false,
        tcodexSessionsExists: false,
        tcodexSessionsReadable: false,
        tcodexSessionsWritable: false,
        codebuddyProjectsExists: false,
        codebuddyProjectsReadable: false,
        codebuddyProjectsWritable: false,
      }),
    });
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "python3", status: "error" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "inotifywait", status: "warning", repairCommand: "sudo apt-get install inotify-tools" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "home", status: "error" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "codex-sessions", status: "error", category: "permission" }));
    expect(report.ok).toBe(false);
  });

  it("reports python3 absence and skips dependent checks instead of masking it as connectivity", async () => {
    const report = await diagnoseRemoteEnvironment(wslEnvironment, {
      runSsh: async () => JSON.stringify({ pythonUnavailable: true, bashAvailable: true }),
    });

    expect(report.checks.map((check) => check.id)).toEqual([
      "connectivity", "bash", "python3", "dependent-checks",
    ]);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "python3", status: "error" }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "dependent-checks",
      status: "warning",
      message: expect.stringContaining("skipped"),
    }));
    expect(report.checks[0]?.status).toBe("ok");
  });

  it("marks connectivity as failed when ssh command fails", async () => {
    const report = await diagnoseRemoteEnvironment(environment, {
      runSsh: async () => {
        throw new Error("Permission denied");
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({
      id: "connectivity",
      status: "error",
      message: "Permission denied",
    });
  });

  it("fails resume preflight when the remote session file is missing", async () => {
    const report = await preflightRemoteSessionResume(environment, session, {
      runSsh: async (_environment, command) => {
        expect(command).toMatch(/^bash -lc /);
        expect(command).toContain("python3 -c");
        expect(command).not.toContain(session.filePath);
        return JSON.stringify({
          ok: false,
          fileExists: false,
          fileReadable: false,
          projectExists: true,
          cliPath: "/usr/local/bin/codex",
        });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "session-file",
        status: "error",
      }),
    );
  });

  it("labels WSL resume connectivity errors as WSL", async () => {
    const report = await preflightRemoteSessionResume(
      wslEnvironment,
      { ...session, environmentId: "wsl-ubuntu", environmentKind: "wsl" } as SessionSearchResult,
      { runSsh: async () => { throw new Error("wsl.exe was not found"); } },
    );

    expect(report.checks[0]).toMatchObject({
      id: "connectivity",
      label: "WSL connection",
      status: "error",
      message: "wsl.exe was not found",
    });
  });

  it("passes resume preflight with a readable session file, existing project, and matching CLI", async () => {
    const report = await preflightRemoteSessionResume(environment, session, {
      runSsh: async () =>
        JSON.stringify({
          ok: true,
          fileExists: true,
          fileReadable: true,
          projectExists: true,
          cliPath: "/usr/local/bin/codex",
        }),
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.status)).toEqual(["ok", "ok", "ok"]);
  });

  it.each([
    ["tclaude-cli", "tclaude"],
    ["tcodex-cli", "tcodex"],
    ["codebuddy-cli", "codebuddy"],
    ["codewiz-cli", "codewiz"],
  ] as const)("preflights %s with %s", async (source, binary) => {
    let script = "";
    await preflightRemoteSessionResume(environment, { ...session, source } as SessionSearchResult, {
      runSsh: async (_environment, command) => {
        script = decodePythonCommand(command);
        return JSON.stringify({
          fileExists: true,
          fileReadable: true,
          projectExists: true,
          cliPath: `/bin/${binary}`,
        });
      },
    });
    expect(script).toContain(`cli = "${binary}"`);
  });
});
