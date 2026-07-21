import { afterEach, describe, expect, test, vi } from "vitest";
import { parseCliVersion } from "./detect";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parseCliVersion", () => {
  test("extracts semver-like versions from common agent output", () => {
    expect(parseCliVersion("codex-cli 0.136.0")).toBe("0.136.0");
    expect(parseCliVersion("2.1.121 (Claude Code)")).toBe("2.1.121");
    expect(parseCliVersion("claude v1.2.3-alpha\nextra")).toBe("1.2.3-alpha");
  });

  test("falls back to the first trimmed line when output has no semver", () => {
    expect(parseCliVersion("custom build\nmore")).toBe("custom build");
  });
});

describe("detectAgentRuntimes", () => {
  test("treats Windows codex.cmd overrides as available when exec succeeds through the launcher adapter", async () => {
    vi.resetModules();
    vi.stubEnv("CODEX_PATH", "C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd");

    const execCli = vi.fn(async (request: { executable: string; args?: string[] }) => {
      if (request.executable === "C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd") {
        return { stdout: "codex-cli 0.136.0\n", stderr: "" };
      }
      throw new Error(`unexpected executable: ${request.executable}`);
    });

    vi.doMock("../../platform/cli-launcher", () => ({ execCli }));
    const { detectAgentRuntimes } = await import("./detect");

    const runtimes = await detectAgentRuntimes();
    const codex = runtimes.find((runtime) => runtime.id === "codex");

    expect(codex).toMatchObject({
      id: "codex",
      command: "C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd",
      available: true,
      version: "0.136.0",
    });
    expect(execCli).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd",
        args: ["--version"],
      }),
    );
  });

  test("detects a Hermes CLI from HERMES_PATH", async () => {
    vi.resetModules();
    vi.stubEnv("HERMES_PATH", "C:\\Users\\demo\\AppData\\Local\\Programs\\Hermes\\hermes.cmd");

    const execCli = vi.fn(async (request: { executable: string; args?: string[] }) => {
      if (request.executable === "C:\\Users\\demo\\AppData\\Local\\Programs\\Hermes\\hermes.cmd") {
        return { stdout: "hermes-cli 1.2.3\n", stderr: "" };
      }
      throw new Error(`unexpected executable: ${request.executable}`);
    });

    vi.doMock("../../platform/cli-launcher", () => ({ execCli }));
     const { detectAgentRuntimes } = await import("./detect");

    const runtimes = await detectAgentRuntimes();
    expect(runtimes.find((runtime) => runtime.id === "hermes")).toMatchObject({
      id: "hermes",
      command: "C:\\Users\\demo\\AppData\\Local\\Programs\\Hermes\\hermes.cmd",
      available: true,
      version: "1.2.3",
    });
  });

  test("detects an OpenCode CLI from OPENCODE_PATH", async () => {
    vi.resetModules();
    vi.stubEnv("OPENCODE_PATH", "C:\\Users\\demo\\AppData\\Roaming\\npm\\opencode.cmd");
    const execCli = vi.fn(async (request: { executable: string; args?: string[] }) => {
      if (request.executable.endsWith("opencode.cmd")) return { stdout: "opencode 1.2.3\n", stderr: "" };
      throw new Error(`unexpected executable: ${request.executable}`);
    });
    vi.doMock("../../platform/cli-launcher", () => ({ execCli }));
    const { detectAgentRuntimes } = await import("./detect");
    const runtimes = await detectAgentRuntimes();
    expect(runtimes.find((runtime) => runtime.id === "opencode")).toMatchObject({
      id: "opencode",
      command: "C:\\Users\\demo\\AppData\\Roaming\\npm\\opencode.cmd",
      available: true,
      version: "1.2.3",
    });
  });

  test("detects an OpenClaw CLI from OPENCLAW_PATH", async () => {
    vi.resetModules();
    vi.stubEnv("OPENCLAW_PATH", "C:\\Users\\demo\\AppData\\Roaming\\npm\\openclaw.cmd");
    const execCli = vi.fn(async (request: { executable: string; args?: string[] }) => {
      if (request.executable.endsWith("openclaw.cmd")) return { stdout: "openclaw 2026.7.1\n", stderr: "" };
      throw new Error(`unexpected executable: ${request.executable}`);
    });
    vi.doMock("../../platform/cli-launcher", () => ({ execCli }));
    const { detectAgentRuntimes } = await import("./detect");
    const runtimes = await detectAgentRuntimes();
    expect(runtimes.find((runtime) => runtime.id === "openclaw")).toMatchObject({
      id: "openclaw",
      command: "C:\\Users\\demo\\AppData\\Roaming\\npm\\openclaw.cmd",
      available: true,
      version: "2026.7.1",
    });
  });
});
