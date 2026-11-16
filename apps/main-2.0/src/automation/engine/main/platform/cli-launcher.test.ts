import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCli, resolveCliInvocation, spawnCli, terminateCliProcess } from "./cli-launcher";

describe("resolveCliInvocation on win32", () => {
  it("unwraps an npm .cmd shim to direct node.exe execution without cmd.exe", () => {
    const existing = new Set([
      "c:\\users\\ada lovelace\\appdata\\roaming\\npm\\opencode.cmd",
      "c:\\users\\ada lovelace\\appdata\\roaming\\npm\\node_modules\\opencode\\bin\\opencode.cjs",
      "c:\\program files\\nodejs\\node.exe",
    ]);
    const longMultiLinePrompt = `Line 1 %TEMP%\nLine 2 "hi & bye" | <tag> ^ !var!\n${"x".repeat(12_000)}`;

    const invocation = resolveCliInvocation("opencode", ["run", longMultiLinePrompt], {
      platform: "win32",
      env: { PATH: "C:\\Program Files\\nodejs;C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm" },
      resolveCommand: (command) => {
        if (command === "opencode") return "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\opencode.CMD";
        if (command === "node.exe") return "C:\\Program Files\\nodejs\\node.exe";
        return null;
      },
      readShim: () => "node_modules\\opencode\\bin\\opencode.cjs",
      fileExists: (filePath) => existing.has(filePath.toLowerCase()),
    });

    expect(invocation).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\node_modules\\opencode\\bin\\opencode.cjs",
        "run",
        longMultiLinePrompt,
      ],
      viaWindowsCmd: false,
    });
  });

  it("prefers adjacent node.exe and sets ELECTRON_RUN_AS_NODE when falling back to Electron", () => {
    const shimPath = "C:\\Tools\\cli.cmd";
    const targetJs = "C:\\Tools\\node_modules\\cli\\index.js";
    const adjacentNode = "C:\\Tools\\node.exe";

    const withAdjacent = resolveCliInvocation(shimPath, ["--version"], {
      platform: "win32",
      env: {},
      fileExists: (filePath) => [shimPath, targetJs, adjacentNode].includes(filePath),
      readShim: () => "node_modules\\cli\\index.js",
      resolveCommand: () => null,
    });
    expect(withAdjacent).toEqual({
      file: adjacentNode,
      args: [targetJs, "--version"],
      viaWindowsCmd: false,
    });

    const withElectronFallback = resolveCliInvocation(shimPath, ["--version"], {
      platform: "win32",
      env: {},
      execPath: "C:\\App\\AgentRecall.exe",
      isElectronRuntime: true,
      fileExists: (filePath) => [shimPath, targetJs].includes(filePath),
      readShim: () => "node_modules\\cli\\index.js",
      resolveCommand: () => null,
    });
    expect(withElectronFallback).toEqual({
      file: "C:\\App\\AgentRecall.exe",
      args: [targetJs, "--version"],
      viaWindowsCmd: false,
      envOverrides: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("prefers .cmd or .exe over extensionless shims when given an explicit extensionless path", () => {
    const extensionless = "C:\\Users\\Dev\\npm\\codex";
    const cmdShim = "C:\\Users\\Dev\\npm\\codex.cmd";
    const targetJs = "C:\\Users\\Dev\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";

    const invocation = resolveCliInvocation(extensionless, ["exec", "--json"], {
      platform: "win32",
      env: { PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (filePath) => [extensionless, cmdShim, targetJs].includes(filePath),
      readShim: () => "node_modules\\@openai\\codex\\bin\\codex.js",
      resolveCommand: (command) => (command === "node.exe" ? "C:\\Program Files\\nodejs\\node.exe" : null),
    });

    expect(invocation).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe",
      args: [targetJs, "exec", "--json"],
      viaWindowsCmd: false,
    });
  });

  it("dispatches .ps1 scripts directly via powershell.exe without cmd.exe", () => {
    const scriptPath = "C:\\Program Files\\Agent Tools\\runner.ps1";
    const invocation = resolveCliInvocation(scriptPath, ["say & run", "line1\nline2"], {
      platform: "win32",
      env: {},
      fileExists: (filePath) => filePath === scriptPath,
      resolveCommand: (command) => (command === "powershell.exe" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : null),
    });

    expect(invocation).toEqual({
      file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "say & run",
        "line1\nline2",
      ],
      viaWindowsCmd: false,
    });
  });

  it("rejects newlines when falling back to a non-unwrappable .bat script", () => {
    const batPath = "C:\\Tools\\custom.bat";
    expect(() =>
      resolveCliInvocation(batPath, ["line1\nline2"], {
        platform: "win32",
        env: {},
        fileExists: (filePath) => filePath === batPath,
        readShim: () => {
          throw new Error("ENOTASHIM");
        },
        readTextFile: () => "@echo off\r\nset CUSTOM=1\r\nfoo.exe %*\r\n",
      })).toThrow(/cannot contain newlines or NUL bytes/i);
  });

  it("leaves missing non-batch executables direct so spawn reports ENOENT", () => {
    const invocation = resolveCliInvocation("definitely-missing-cli", ["--version"], {
      platform: "win32",
      env: {},
      resolveCommand: () => null,
    });

    expect(invocation).toEqual({
      file: "definitely-missing-cli",
      args: ["--version"],
      viaWindowsCmd: false,
    });
  });
});

describe("terminateCliProcess", () => {
  it("invokes taskkill /PID /T /F on win32 before falling back to direct kill", () => {
    const unref = vi.fn();
    const onceMock = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref, once: onceMock }) as unknown as ReturnType<typeof spawnCli>);
    const kill = vi.fn(() => true);

    terminateCliProcess(
      { pid: 4321, killed: false, exitCode: null, kill },
      "SIGTERM",
      { platform: "win32", spawnImpl: spawnImpl as never },
    );

    expect(spawnImpl).toHaveBeenCalledWith("taskkill", ["/PID", "4321", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    expect(unref).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });

  it("signals the child directly on POSIX platforms", () => {
    const kill = vi.fn(() => true);
    terminateCliProcess(
      { pid: 4321, killed: false, exitCode: null, kill },
      "SIGINT",
      { platform: "darwin" },
    );
    expect(kill).toHaveBeenCalledWith("SIGINT");
  });
});

describe.skipIf(process.platform !== "win32")("Windows real CLI launcher behavior", () => {
  const tempDirs = new Set<string>();
  const leftoverPids = new Set<number>();

  afterEach(async () => {
    for (const pid of leftoverPids) {
      try {
        process.kill(pid);
      } catch {
        // Process tree was already terminated by the test under verification.
      }
    }
    leftoverPids.clear();
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  async function createTempDir(prefix: string): Promise<string> {
    const base = await mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.add(base);
    const spaced = path.join(base, "Program Files", "Agent & Tools");
    await mkdir(spaced, { recursive: true });
    return spaced;
  }

  it("preserves multi-line prompts, quotes, metacharacters, %ENV%, and >8191-char payloads across npm .cmd shims", async () => {
    const binDir = await createTempDir("cli-launcher-npm-");
    const pkgDir = path.join(binDir, "node_modules", "fake-cli", "bin");
    await mkdir(pkgDir, { recursive: true });

    const entryJs = path.join(pkgDir, "cli.cjs");
    await writeFile(entryJs, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");

    // Sibling POSIX /bin/sh shim without extension must lose to .cmd when path has no extension.
    await writeFile(path.join(binDir, "agentcli"), "#!/bin/sh\necho WRONG_SHIM\n", "utf8");
    const cmdShim = path.join(binDir, "agentcli.cmd");
    await writeFile(
      cmdShim,
      `@ECHO off\r\nSET dp0=%~dp0\r\n"${process.execPath}"  "%dp0%\\node_modules\\fake-cli\\bin\\cli.cjs" %*\r\n`,
      "utf8",
    );

    const payloadArgs = [
      "run",
      `Line 1\nLine 2 with "quotes" & pipes | <redirects> ^ caret !bang!\n%TEMP% %PATH%\nC:\\Program Files\\Trailing\\\n${"A".repeat(12_000)}`,
    ];

    const execResult = await execCli({
      executable: path.join(binDir, "agentcli"),
      args: payloadArgs,
      cwd: binDir,
      env: { ...process.env, AGENT_RECALL_NODE_PATH: process.execPath },
    });
    expect(JSON.parse(execResult.stdout)).toEqual(payloadArgs);

    const child = spawnCli({
      executable: "agentcli",
      args: payloadArgs,
      cwd: binDir,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let streamed = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      streamed += chunk.toString();
    });
    const [code] = await once(child, "close");
    expect(code).toBe(0);
    expect(JSON.parse(streamed)).toEqual(payloadArgs);
  });

  it("round-trips quotes, percent variables, and shell metacharacters through custom .cmd batch scripts", async () => {
    const dir = await createTempDir("cli-launcher-bat-");
    const dumpJs = path.join(dir, "dump.cjs");
    const customCmd = path.join(dir, "custom & cli.cmd");
    await writeFile(dumpJs, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");
    await writeFile(
      customCmd,
      `@echo off\r\nset CUSTOM_FLAG=1\r\n"${process.execPath}" "${dumpJs}" %*\r\n`,
      "utf8",
    );

    const args = [
      "",
      "plain",
      'say "hi & bye"',
      "%TEMP% %1 %*",
      "!BANG! ^caret^ (parens) a|b<c>d",
      "C:\\Program Files\\Trailing\\",
    ];

    const result = await execCli({
      executable: customCmd,
      args,
      cwd: dir,
    });
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it("executes .ps1 scripts directly with special arguments in spaced paths", async () => {
    const dir = await createTempDir("cli-launcher-ps1-");
    const ps1Path = path.join(dir, "echo args.ps1");
    await writeFile(
      ps1Path,
      "Write-Output ([string]::Join('|', $args))\r\n",
      "utf8",
    );

    const result = await execCli({
      executable: ps1Path,
      args: ["alpha", "two words", "%TEMP%", "a & b"],
      cwd: dir,
    });
    expect(result.stdout.trim()).toBe("alpha|two words|%TEMP%|a & b");
  });

  it("terminates the entire Windows process tree so grandchildren holding stdout close cleanly", async () => {
    const dir = await createTempDir("cli-launcher-tree-");
    const wrapperCmd = path.join(dir, "tree.cmd");
    const parentJs = path.join(dir, "parent.cjs");
    await writeFile(
      parentJs,
      `
        const { spawn } = require("node:child_process");
        const grand = spawn(${JSON.stringify(process.execPath)}, ["-e", "setInterval(() => {}, 60000)"], { stdio: "inherit" });
        process.stdout.write("GRANDPID:" + grand.pid + "\\n");
        setInterval(() => {}, 60000);
      `,
      "utf8",
    );
    await writeFile(
      wrapperCmd,
      `@echo off\r\nset TREE_MARKER=1\r\n"${process.execPath}" "${parentJs}" %*\r\n`,
      "utf8",
    );

    const proc = spawnCli({
      executable: wrapperCmd,
      args: [],
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (proc.pid) leftoverPids.add(proc.pid);

    const grandPid = await new Promise<number>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = stdout.match(/GRANDPID:(\d+)/);
        if (match) resolve(Number(match[1]));
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.once("error", reject);
      proc.once("exit", (code) => reject(new Error(`Exited prematurely (${String(code)}): ${stderr}`)));
    });
    leftoverPids.add(grandPid);

    const closed = once(proc, "close");
    terminateCliProcess(proc, "SIGTERM");
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for process tree close")), 5_000)),
    ]);

    expect(() => process.kill(grandPid, 0)).toThrow();
    leftoverPids.delete(grandPid);
    if (proc.pid) leftoverPids.delete(proc.pid);
  });
});
