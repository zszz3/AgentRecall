import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCli, spawnCli } from "./cli-launcher";
import { resolveDshDesktopInvocation } from "./dsh-desktop-launcher";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, existsSync: vi.fn(original.existsSync) };
});

describe.skipIf(process.platform !== "darwin")("DSH desktop CLI fallback", () => {
  let home: string | undefined;
  afterEach(async () => {
    vi.mocked(existsSync).mockRestore();
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  it("leaves explicit commands and unrelated runtimes unchanged", () => {
    const env = { HOME: "/synthetic-home", PATH: "" };
    expect(resolveDshDesktopInvocation("/custom/dsh", [], env)).toBeUndefined();
    expect(resolveDshDesktopInvocation("codex", [], env)).toBeUndefined();
  });

  it("does not substitute a desktop installation when a CLI exists on PATH", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dsh-cli-priority-"));
    await writeFile(path.join(home, "dsh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    expect(resolveDshDesktopInvocation("dsh", [], { HOME: home, PATH: home })).toBeUndefined();
  });

  it("leaves a missing installation as an ordinary missing command", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(resolveDshDesktopInvocation("dsh", [], { HOME: "/synthetic-home", PATH: "" })).toBeUndefined();
  });

  it("uses the desktop CLI for both config probes and spawned tasks with intact arguments and environment", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-launch-"));
    const contents = path.join(home, "Applications", "DeepSeek Harness.app", "Contents");
    const bin = path.join(contents, "MacOS", "DeepSeek Harness");
    const cli = path.join(contents, "Resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    await mkdir(path.dirname(bin), { recursive: true });
    await mkdir(path.dirname(cli), { recursive: true });
    const quotedNode = `'${process.execPath.replace(/'/g, "'\\''")}'`;
    await writeFile(bin, `#!/bin/sh\nexec ${quotedNode} "$@"\n`, { mode: 0o700 });
    await writeFile(cli, 'console.log(JSON.stringify({args:process.argv.slice(2),nodeMode:process.env.ELECTRON_RUN_AS_NODE,home:process.env.DSH_HOME,custom:process.env.CUSTOM_VALUE}));\n');
    const env = { HOME: home, PATH: home, DSH_HOME: path.join(home, "dsh home"), CUSTOM_VALUE: "kept" };
    const probe = await execCli({ executable: "dsh", args: ["--version"], env, cwd: home, timeout: 5000 });
    expect(JSON.parse(probe.stdout)).toEqual({ args: ["--version"], nodeMode: "1", home: env.DSH_HOME, custom: "kept" });
    const args = ["--profile", "headless", 'Reply with "hello"; $HOME `ignored` 中文'];
    const child = spawnCli({ executable: "dsh", args, env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const [code] = await once(child, "close");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ args, nodeMode: "1", home: env.DSH_HOME, custom: "kept" });
  });
});
