import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL } from "../../shared/models";
import type { AgentChannel } from "../../shared/types";
import { loadRuntimeLocalConfig } from "./runtime-local-config";

function channel(environment?: Record<string, string>): AgentChannel {
  return {
    id: "dsh-custom",
    agentId: "dsh",
    label: "DeepSeek Harness",
    presetId: "dsh-default",
    models: [{ id: DEFAULT_MODEL_ID, label: DEFAULT_MODEL_LABEL }],
    ...(environment ? { environment } : {}),
  };
}

function enoent(): NodeJS.ErrnoException {
  const error = new Error("missing") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

describe("loadRuntimeLocalConfig for DeepSeek Harness", () => {
  it("imports the composed headless profile instead of stale legacy settings", async () => {
    const readTextFile = vi.fn();
    const exec = vi.fn(async () => ({ stdout: [
      "- id: unrelated",
      "  config:",
      "    expression: !!js process.env.DO_NOT_EVALUATE",
      "- id: agent-default-model",
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      "  config:",
      "    provider: deepseek-official",
      "    model: deepseek-flash",
    ].join("\n"), stderr: "" }));
    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "/custom/dsh",
      existingChannel: channel({ DSH_HOME: "~/Harness", CUSTOM_VALUE: "kept" }),
      workingDirectory: "/work/project",
      dependencies: {
        homeDir: "/Users/tester", environment: { DSH_HOME: "/stale/home", PARENT: "kept" },
        pathApi: path.posix, readTextFile: readTextFile as never, exec,
        fileExists: (file) => file === "/Users/tester/Harness/profiles/desktop/cordis.patch.yml",
      },
    });
    expect(readTextFile).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({
      executable: "/custom/dsh", args: ["--profile", "headless", "--dump-config"],
      env: { DSH_HOME: "/Users/tester/Harness", CUSTOM_VALUE: "kept", PARENT: "kept" },
      cwd: "/work/project", timeout: 10_000,
    }));
    expect(result.source).toBe("/custom/dsh --profile headless --dump-config");
    expect(result.channel).toMatchObject({
      modelProvider: "deepseek-official",
      models: [{ id: DEFAULT_MODEL_ID, label: "Default (DSH: deepseek-flash)" }],
    });
    expect(result.channel).not.toHaveProperty("httpHeaders");
  });

  it("surfaces profile composition failures rather than importing a stale model", async () => {
    await expect(loadRuntimeLocalConfig({
      runtimeId: "dsh", executable: "dsh",
      dependencies: {
        homeDir: "/synthetic-home", environment: {}, fileExists: () => true,
        exec: vi.fn(async () => { throw new Error("Invalid headless profile"); }),
      },
    })).rejects.toThrow("Invalid headless profile");
  });

  it("drops old model metadata when the composed profile has no default selection", async () => {
    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh", executable: "dsh",
      existingChannel: { ...channel(), modelProvider: "stale", providerName: "stale" },
      dependencies: {
        homeDir: "/synthetic-home", environment: {}, fileExists: () => true,
        exec: vi.fn(async () => ({ stdout: "- id: other\n  config: {}\n", stderr: "" })),
      },
    });
    expect(result.channel.models).toEqual([{ id: DEFAULT_MODEL_ID, label: DEFAULT_MODEL_LABEL }]);
    expect(result.channel).not.toHaveProperty("modelProvider");
  });

  it("prefers the channel DSH_HOME and imports only the default model display metadata", async () => {
    const readTextFile = vi.fn(async () => [
      "other-section:",
      "  model: ignored",
      "agent-default-model:",
      "  provider: 'deepseek'",
      "  model: \"deepseek-chat\"",
      "",
    ].join("\n"));

    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh",
      existingChannel: channel({ DSH_HOME: "/channel/dsh", KEEP_ME: "yes" }),
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "/Users/tester",
        environment: { DSH_HOME: "/process/dsh" },
        pathApi: path.posix,
      },
    });

    expect(result.source).toBe("/channel/dsh/settings.yaml");
    expect(readTextFile).toHaveBeenCalledOnce();
    expect(readTextFile).toHaveBeenCalledWith("/channel/dsh/settings.yaml", "utf8");
    expect(readTextFile.mock.calls.flat().join(" ")).not.toContain(".credentials.yaml");
    expect(result.channel).toMatchObject({
      id: "dsh-custom",
      agentId: "dsh",
      presetId: "dsh-default",
      modelProvider: "deepseek",
      providerName: "deepseek",
      environment: { DSH_HOME: "/channel/dsh", KEEP_ME: "yes" },
      models: [{ id: DEFAULT_MODEL_ID, label: "Default (DSH: deepseek-chat)" }],
    });
    expect(result.channel.models).toHaveLength(1);
  });

  it("expands a process DSH_HOME beginning with tilde against the supplied OS home", async () => {
    const readTextFile = vi.fn(async () => [
      "agent-default-model:",
      "    provider: gateway",
      "    model: gateway/model-v1 # selected in DSH",
    ].join("\n"));

    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh",
      existingChannel: channel({ KEEP_ME: "yes" }),
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "/Users/tester",
        environment: { DSH_HOME: "~/Library/DeepSeek Harness" },
        pathApi: path.posix,
      },
    });

    expect(result.source).toBe("/Users/tester/Library/DeepSeek Harness/settings.yaml");
    expect(result.channel.models).toEqual([
      { id: DEFAULT_MODEL_ID, label: "Default (DSH: gateway/model-v1)" },
    ]);
  });

  it("parses quoted scalars with comments without reading nested lookalike keys", async () => {
    const readTextFile = vi.fn(async () => [
      "agent-default-model:",
      "  nested:",
      "    provider: wrong-provider",
      "    model: wrong-model",
      "  provider: 'deepseek#official' # selected provider",
      "  model: \"deepseek-chat\" # selected model",
    ].join("\n"));

    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh",
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "/Users/tester",
        environment: {},
        pathApi: path.posix,
      },
    });

    expect(result.channel).toMatchObject({
      modelProvider: "deepseek#official",
      providerName: "deepseek#official",
      models: [{ id: DEFAULT_MODEL_ID, label: "Default (DSH: deepseek-chat)" }],
    });
  });

  it("lets an explicit blank channel DSH_HOME override the process environment", async () => {
    const readTextFile = vi.fn(async () => {
      throw enoent();
    });

    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh",
      existingChannel: channel({ DSH_HOME: "" }),
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "/Users/tester",
        environment: { DSH_HOME: "/process/dsh" },
        pathApi: path.posix,
      },
    });

    expect(result.source).toBe("/Users/tester/.dsh/settings.yaml");
    expect(result.channel.environment).toEqual({ DSH_HOME: "" });
  });

  it("resolves a relative DSH_HOME against the Runtime working directory", async () => {
    const readTextFile = vi.fn(async () => {
      throw enoent();
    });

    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh",
      existingChannel: channel({ DSH_HOME: ".dsh-project" }),
      workingDirectory: "C:\\workspace\\project",
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "C:\\Users\\tester",
        environment: {},
        pathApi: path.win32,
      },
    });

    expect(result.source).toBe("C:\\workspace\\project\\.dsh-project\\settings.yaml");
  });

  it("uses native Windows path rules for Windows homes and tilde overrides", async () => {
    const readTextFile = vi.fn(async () => [
      "agent-default-model:",
      "  provider: deepseek",
      "  model: deepseek-reasoner",
    ].join("\r\n"));

    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh.exe",
      existingChannel: channel({ DSH_HOME: "~\\.dsh-preview" }),
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "C:\\Users\\tester",
        environment: {},
        pathApi: path.win32,
      },
    });

    expect(result.source).toBe("C:\\Users\\tester\\.dsh-preview\\settings.yaml");
    expect(readTextFile).toHaveBeenCalledWith(
      "C:\\Users\\tester\\.dsh-preview\\settings.yaml",
      "utf8",
    );
  });

  it("preserves an absolute Windows DSH_HOME instead of resolving it with POSIX separators", async () => {
    const readTextFile = vi.fn(async () => {
      throw enoent();
    });

    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh.exe",
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "C:\\Users\\tester",
        environment: { DSH_HOME: "D:\\Harness Data" },
        pathApi: path.win32,
      },
    });

    expect(result.source).toBe("D:\\Harness Data\\settings.yaml");
  });

  it("safely falls back to <home>/.dsh when settings.yaml is absent", async () => {
    const readTextFile = vi.fn(async () => {
      throw enoent();
    });

    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh",
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "/Users/tester",
        environment: {},
        pathApi: path.posix,
      },
    });

    expect(result.source).toBe("/Users/tester/.dsh/settings.yaml");
    expect(result.channel).toEqual({
      id: "dsh-default",
      label: "DeepSeek Harness",
      presetId: "dsh-default",
      agentId: "dsh",
      models: [{ id: DEFAULT_MODEL_ID, label: DEFAULT_MODEL_LABEL }],
    });
    expect(readTextFile).toHaveBeenCalledOnce();
  });

  it("drops stale provider metadata when the settings section is incomplete", async () => {
    const readTextFile = vi.fn(async () => [
      "agent-default-model:",
      "  provider: deepseek",
    ].join("\n"));
    const existing = {
      ...channel(),
      modelProvider: "stale",
      providerName: "Stale",
      models: [{ id: "stale-model", label: "Stale model" }],
    };

    const result = await loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh",
      existingChannel: existing,
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "/Users/tester",
        environment: {},
        pathApi: path.posix,
      },
    });

    expect(result.channel.models).toEqual([
      { id: DEFAULT_MODEL_ID, label: DEFAULT_MODEL_LABEL },
    ]);
    expect(result.channel).not.toHaveProperty("modelProvider");
    expect(result.channel).not.toHaveProperty("providerName");
  });

  it("reports malformed settings instead of pretending the import succeeded", async () => {
    const readTextFile = vi.fn(async () => [
      "agent-default-model:",
      "  provider: [unterminated",
    ].join("\n"));

    await expect(loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh",
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "/Users/tester",
        environment: {},
        pathApi: path.posix,
      },
    })).rejects.toThrow(/Failed to parse DSH settings at \/Users\/tester\/\.dsh\/settings\.yaml/u);
  });

  it("does not hide non-absence filesystem failures", async () => {
    const readTextFile = vi.fn(async () => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    await expect(loadRuntimeLocalConfig({
      runtimeId: "dsh",
      executable: "dsh",
      dependencies: {
        readTextFile: readTextFile as never,
        homeDir: "/Users/tester",
        environment: {},
        pathApi: path.posix,
      },
    })).rejects.toThrow("permission denied");
  });
});
