import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectGatewayAgents,
  restoreAgentFromGateway,
  wireAgentToGateway,
  type GatewayWiringContext,
} from "./gateway-agent-wiring";

describe("gateway-agent-wiring", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  });

  async function makeCtx(): Promise<GatewayWiringContext> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gw-wire-"));
    tempDirs.push(root);
    const homeDir = path.join(root, "home");
    const userDataPath = path.join(root, "userdata");
    await Promise.all([
      fsp.mkdir(path.join(homeDir, ".claude"), { recursive: true }),
      fsp.mkdir(path.join(homeDir, ".codex"), { recursive: true }),
      fsp.mkdir(path.join(homeDir, ".dsh", "profiles", "default"), { recursive: true }),
      fsp.mkdir(userDataPath, { recursive: true }),
    ]);
    return {
      homeDir,
      userDataPath,
      env: {},
      gatewayBaseUrl: "http://127.0.0.1:4325",
      localToken: "ar-gw-synthetic",
      defaultModel: "deepseek-chat",
      agentModels: {},
    };
  }

  it("writes and restores Claude Code settings.json while preserving unrelated keys", async () => {
    const ctx = await makeCtx();
    const settingsPath = path.join(ctx.homeDir, ".claude", "settings.json");
    const original = `${JSON.stringify({ permissions: { allow: ["Read"] }, env: { FOO: "bar" } }, null, 2)}\n`;
    await fsp.writeFile(settingsPath, original);

    await wireAgentToGateway("claude-code", ctx);
    const wired = JSON.parse(await fsp.readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(wired.permissions).toEqual({ allow: ["Read"] });
    expect((wired.env as Record<string, string>).FOO).toBe("bar");
    expect((wired.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4325/agent/claude-code");

    const statuses = await inspectGatewayAgents(ctx);
    expect(statuses.find((a) => a.agentId === "claude-code")).toMatchObject({ wired: true, hasBackup: true });

    await restoreAgentFromGateway("claude-code", ctx);
    expect(await fsp.readFile(settingsPath, "utf8")).toBe(original);
  });

  it("writes and restores Codex config.toml and DeepSeek Harness cordis.patch.yml losslessly", async () => {
    const ctx = await makeCtx();
    const codexPath = path.join(ctx.homeDir, ".codex", "config.toml");
    const originalCodex = 'model_provider = "openai"\nmodel = "gpt-5"\n\n[tui]\nnotifications = true\n';
    await fsp.writeFile(codexPath, originalCodex);

    await wireAgentToGateway("codex", ctx);
    const wiredCodex = await fsp.readFile(codexPath, "utf8");
    expect(wiredCodex).toContain('model_provider = "agentrecall"');
    expect(wiredCodex).toContain('base_url = "http://127.0.0.1:4325/agent/codex/v1"');
    expect(wiredCodex).toContain("[tui]");

    await wireAgentToGateway("deepseek-harness", ctx);
    const dshPatch = await fsp.readFile(path.join(ctx.homeDir, ".dsh", "profiles", "default", "cordis.patch.yml"), "utf8");
    expect(dshPatch).toContain("http://127.0.0.1:4325/agent/deepseek-harness/v1");
    expect(dshPatch).toContain("AGENTRECALL_GATEWAY_KEY");
    expect(dshPatch).toContain("id: deepseek-chat");

    const afterWire = await inspectGatewayAgents(ctx);
    expect(afterWire.find((a) => a.agentId === "codex")?.wired).toBe(true);
    expect(afterWire.find((a) => a.agentId === "deepseek-harness")?.wired).toBe(true);

    await restoreAgentFromGateway("codex", ctx);
    expect(await fsp.readFile(codexPath, "utf8")).toBe(originalCodex);
    await restoreAgentFromGateway("deepseek-harness", ctx);
    const afterRestore = await inspectGatewayAgents(ctx);
    expect(afterRestore.find((a) => a.agentId === "deepseek-harness")?.wired).toBe(false);
  });

  it("prefers DeepSeek Harness desktop profile over auxiliary acp profile", async () => {
    const ctx = await makeCtx();
    await fsp.rm(path.join(ctx.homeDir, ".dsh", "profiles", "default"), { recursive: true, force: true });
    await fsp.mkdir(path.join(ctx.homeDir, ".dsh", "profiles", "acp"), { recursive: true });
    await fsp.mkdir(path.join(ctx.homeDir, ".dsh", "profiles", "desktop"), { recursive: true });

    await wireAgentToGateway("deepseek-harness", ctx);
    const desktopPatch = await fsp.readFile(path.join(ctx.homeDir, ".dsh", "profiles", "desktop", "cordis.patch.yml"), "utf8");
    expect(desktopPatch).toContain("http://127.0.0.1:4325/agent/deepseek-harness/v1");
    expect(desktopPatch).toContain("id: deepseek-chat");
  });
});
