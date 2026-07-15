import { describe, expect, it } from "vitest";
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

function decodePythonCommand(command: string): string {
  const match = command.match(/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/);
  if (!match?.[1]) throw new Error("Expected an encoded Python command");
  return Buffer.from(match[1], "base64").toString("utf-8");
}

describe("remote health checks", () => {
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
