import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJudgeScriptRunner, normalizeJudgeScriptResult } from "./judge-script-runner";
import type { EvaluationJudgeScriptInput } from "./nodes/contracts";

function subject(): Omit<EvaluationJudgeScriptInput, "script"> {
  return {
    task: {
      caseId: "case-1",
      datasetItemId: "item-1",
      repetition: 1,
      input: "add 2 and 2",
      expectedOutput: "4",
      metadata: {},
    },
    artifact: { output: "the answer is 4", origin: { kind: "agent_run" } },
    trajectory: {
      turnCount: 3,
      toolCallCount: 4,
      toolFailureCount: 1,
      failedToolNames: ["bash"],
      totalTokens: 1200,
      errorCount: 0,
      usedSkillNames: [],
      skillUsageObservable: true,
    },
  };
}

function inline(source: string, timeoutMs?: number): EvaluationJudgeScriptInput {
  return {
    ...subject(),
    script: { mode: "inline_js", source, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
  };
}

describe("inline judge scripts", () => {
  const run = createJudgeScriptRunner();

  it("scores the artifact with the user's own code", async () => {
    const result = await run(inline(`
      const correct = artifact.output.includes(task.expectedOutput);
      return { score: correct ? 1 : 0, reason: correct ? "found it" : "missing" };
    `));

    expect(result.verdicts).toEqual([{ score: 1, reason: "found it" }]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("accepts a bare number, because that is what a one-line judge returns", async () => {
    const result = await run(inline("return artifact.output.length > 3 ? 0.75 : 0;"));

    expect(result.verdicts).toEqual([{ score: 0.75 }]);
  });

  it("lets one script score several dimensions in one pass", async () => {
    const result = await run(inline(`
      return [
        { score: 1, dimension: "correctness" },
        { score: trajectory.toolFailureCount === 0 ? 1 : 0, dimension: "cleanliness" },
      ];
    `));

    expect(result.verdicts).toEqual([
      { score: 1, dimension: "correctness" },
      { score: 0, dimension: "cleanliness" },
    ]);
  });

  it("reads the trajectory when that is what the script was given", async () => {
    const result = await run({
      ...subject(),
      artifact: undefined,
      script: { mode: "inline_js", source: "return { score: 1 / trajectory.turnCount };" },
    });

    expect(result.verdicts[0]!.score).toBeCloseTo(1 / 3);
  });

  it("awaits an async judge", async () => {
    const result = await run(inline("return Promise.resolve({ score: 0.5 });"));

    expect(result.verdicts).toEqual([{ score: 0.5 }]);
  });

  it("rejects rather than scoring zero when the script throws", async () => {
    // The whole point of the excuse path: a bug in the judge must not read as
    // "the agent answered badly".
    await expect(run(inline("throw new Error('my judge is broken');")))
      .rejects.toThrow(/my judge is broken/);
  });

  it("includes the script's own logging in the failure", async () => {
    await expect(run(inline(`
      console.log("checked", { seen: artifact.output });
      throw new Error("gave up");
    `))).rejects.toThrow(/checked \{"seen":"the answer is 4"\}/);
  });

  it("rejects a script that returns nothing", async () => {
    await expect(run(inline("const unused = 1;"))).rejects.toThrow(/script_returned_no_verdict/);
  });

  it("rejects a score that is not a number", async () => {
    await expect(run(inline("return { score: 'great' };")))
      .rejects.toThrow(/script_score_is_not_a_number/);
  });

  it("rejects an empty script instead of passing everything", async () => {
    await expect(run(inline("   "))).rejects.toThrow(/script_is_empty/);
  });

  it("stops a synchronous loop that never ends", async () => {
    await expect(run(inline("while (true) {}", 40))).rejects.toThrow();
  });

  it("stops an async judge that never settles", async () => {
    await expect(run(inline("return new Promise(() => {});", 40)))
      .rejects.toThrow(/script_timed_out/);
  });
});

describe("the inline sandbox", () => {
  const run = createJudgeScriptRunner();

  it("has no module loader, filesystem or network", async () => {
    const absent = ["require", "process", "fetch", "Buffer", "globalThis.process"];
    const result = await run(inline(
      `return { score: [${absent.map((name) => `typeof ${name}`).join(", ")}]
        .every((kind) => kind === "undefined") ? 1 : 0 };`,
    ));

    expect(result.verdicts).toEqual([{ score: 1 }]);
  });

  it("cannot generate more code at run time", async () => {
    await expect(run(inline("return { score: eval('1') };"))).rejects.toThrow();
  });

  it("cannot mutate the values it was given", async () => {
    // Each script gets a copy, so a judge that edits the artifact cannot change
    // what the next judge sees.
    const input = inline("artifact.output = 'rewritten'; return { score: 1 };");
    await run(input);

    expect(input.artifact!.output).toBe("the answer is 4");
  });
});

describe("command judge scripts", () => {
  function fakeSpawn(behaviour: {
    stdout?: string;
    stderr?: string;
    code?: number;
    spawnError?: Error;
    hang?: boolean;
  }) {
    const stdinChunks: string[] = [];
    const spawnCommand = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdin = { end: (chunk: string) => { stdinChunks.push(chunk); } };
      child.kill = () => {
        setImmediate(() => child.emit("close", null));
        return true;
      };
      setImmediate(() => {
        if (behaviour.hang) return;
        if (behaviour.spawnError) child.emit("error", behaviour.spawnError);
        if (behaviour.stdout) stdout.emit("data", behaviour.stdout);
        if (behaviour.stderr) stderr.emit("data", behaviour.stderr);
        child.emit("close", behaviour.code ?? 0);
      });
      return child;
    });
    return { spawnCommand: spawnCommand as never, stdinChunks, calls: spawnCommand };
  }

  function commandInput(overrides: Record<string, unknown> = {}): EvaluationJudgeScriptInput {
    return {
      ...subject(),
      script: { mode: "command", command: "./judge.sh", args: ["--strict"], ...overrides } as never,
    };
  }

  it("hands the subject to the command on stdin and reads its verdict from stdout", async () => {
    const fake = fakeSpawn({ stdout: '{"score": 0.9, "dimension": "style"}' });
    const run = createJudgeScriptRunner({
      commandsEnabled: () => true,
      spawnCommand: fake.spawnCommand,
      defaultCwd: "/tmp/eval",
    });

    const result = await run(commandInput());

    expect(result.verdicts).toEqual([{ score: 0.9, dimension: "style" }]);
    expect(JSON.parse(fake.stdinChunks[0]!)).toMatchObject({
      task: { input: "add 2 and 2" },
      artifact: { output: "the answer is 4" },
    });
    const [command, args, spawnOptions] = fake.calls.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe("./judge.sh");
    expect(args).toEqual(["--strict"]);
    expect(spawnOptions).toMatchObject({ cwd: "/tmp/eval", shell: false });
  });

  it("takes the last JSON block, so a judge may print progress first", async () => {
    const fake = fakeSpawn({ stdout: 'checking...\nstill checking\n[{"score": 1}]' });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    expect((await run(commandInput())).verdicts).toEqual([{ score: 1 }]);
  });

  it("refuses to spawn anything while command judges are switched off", async () => {
    const fake = fakeSpawn({ stdout: '{"score": 1}' });
    const run = createJudgeScriptRunner({ commandsEnabled: () => false, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput())).rejects.toThrow(/script_commands_not_enabled/);
    expect(fake.calls).not.toHaveBeenCalled();
  });

  it("reports a non-zero exit with the command's own stderr", async () => {
    const fake = fakeSpawn({ code: 2, stderr: "cannot open the rubric" });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput()))
      .rejects.toThrow(/script_command_exited_2: cannot open the rubric/);
  });

  it("reports output that is not a verdict", async () => {
    const fake = fakeSpawn({ stdout: "looks fine to me" });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput())).rejects.toThrow(/script_command_output_not_json/);
  });

  it("reports a command that printed nothing", async () => {
    const fake = fakeSpawn({});
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput())).rejects.toThrow(/script_command_printed_nothing/);
  });

  it("reports a command that could not be spawned at all", async () => {
    const fake = fakeSpawn({ spawnError: new Error("ENOENT"), code: 1 });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput())).rejects.toThrow(/script_command_failed: ENOENT/);
  });

  it("kills a command that overruns its timeout", async () => {
    const fake = fakeSpawn({ hang: true });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });

    await expect(run(commandInput({ timeoutMs: 20 }))).rejects.toThrow(/script_timed_out/);
  });

  it("stops when the run is cancelled", async () => {
    const fake = fakeSpawn({ hang: true });
    const run = createJudgeScriptRunner({ commandsEnabled: () => true, spawnCommand: fake.spawnCommand });
    const controller = new AbortController();
    const pending = run({ ...commandInput(), signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/script_aborted/);
  });

  it("always passes windowsHide: true on POSIX spawns too", async () => {
    const fake = fakeSpawn({ stdout: '{"score": 1}' });
    const run = createJudgeScriptRunner({
      commandsEnabled: () => true,
      spawnCommand: fake.spawnCommand,
      platform: "linux",
    });

    await run(commandInput());

    const [, , spawnOptions] = fake.calls.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(spawnOptions).toMatchObject({ shell: false, windowsHide: true });
  });
});

describe("Windows command judge resolution and termination", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      await fs.rm(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-runner-win-"));
    tempRoots.push(dir);
    return dir;
  }

  function mockSpawn(handler: (command: string, args: string[], options: Record<string, unknown>) => {
    pid?: number;
    stdout?: string;
    stderr?: string;
    code?: number | null;
    error?: Error;
    hang?: boolean;
    onKill?: () => void;
  }) {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const stdinChunks: string[] = [];
    const spawnCommand = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      const behavior = handler(command, args, options);
      const child = new EventEmitter() as EventEmitter & {
        pid?: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { end: (chunk: string) => void; on: (event: string, fn: () => void) => void };
        kill: (signal?: string) => boolean;
        unref: () => void;
      };
      child.pid = behavior.pid;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        end: (chunk: string) => { stdinChunks.push(chunk); },
        on: () => {},
      };
      child.kill = () => {
        behavior.onKill?.();
        setImmediate(() => child.emit("close", null));
        return true;
      };
      child.unref = () => {};
      setImmediate(() => {
        if (behavior.hang) return;
        if (behavior.error) child.emit("error", behavior.error);
        if (behavior.stdout) child.stdout.emit("data", behavior.stdout);
        if (behavior.stderr) child.stderr.emit("data", behavior.stderr);
        child.emit("close", behavior.code ?? 0);
      });
      return child;
    });
    return { spawnCommand: spawnCommand as never, calls, stdinChunks };
  }

  it("unwraps bare Windows npm .cmd shims to invoke node.exe directly without cmd.exe", async () => {
    const dir = await makeTempDir();
    const binDir = path.join(dir, "bin");
    const target = path.join(dir, "node_modules", "rubric-cli", "bin", "judge.mjs");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "// synthetic judge script\n", "utf8");
    const adjacentNode = path.join(binDir, "node.exe");
    await fs.writeFile(adjacentNode, "", "utf8");
    await fs.writeFile(
      path.join(binDir, "my-judge.cmd"),
      '@ECHO off\r\n"%~dp0\\..\\node_modules\\rubric-cli\\bin\\judge.mjs" %*\r\n',
      "utf8",
    );

    const mocked = mockSpawn(() => ({ stdout: '{"score": 1}' }));
    const run = createJudgeScriptRunner({
      commandsEnabled: () => true,
      spawnCommand: mocked.spawnCommand,
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT" },
    });

    const result = await run({
      ...subject(),
      script: { mode: "command", command: "my-judge", args: ["--strict", "a & b"] },
    });

    expect(result.verdicts).toEqual([{ score: 1 }]);
    expect(mocked.calls).toHaveLength(1);
    expect(mocked.calls[0]!.command).toBe(realpathSync(adjacentNode));
    expect(mocked.calls[0]!.args).toEqual([realpathSync(target), "--strict", "a & b"]);
    expect(mocked.calls[0]!.options).toMatchObject({ shell: false, windowsHide: true });
  });

  it("falls back to ComSpec with /d /v:off /s /c and verbatim escaping for genuine batch files", async () => {
    const dir = await makeTempDir();
    const bat = path.join(dir, "judge & check.bat");
    await fs.writeFile(bat, "@echo off\r\nexit /b 0\r\n", "utf8");

    const mocked = mockSpawn(() => ({ stdout: '{"score": 0.5}' }));
    const run = createJudgeScriptRunner({
      commandsEnabled: () => true,
      spawnCommand: mocked.spawnCommand,
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });

    await run({
      ...subject(),
      script: { mode: "command", command: bat, args: ["100% & !TEMP!", 'say "hi"', "C:\\dir\\"] },
    });

    const call = mocked.calls[0]!;
    expect(call.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(call.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(call.args[4]).toBe(
      `""${realpathSync(bat)}" "100"^%" & !TEMP!" "say ""hi""" "C:\\dir\\\\""`,
    );
    expect(call.options).toMatchObject({
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });

  it("launches .ps1 judges via powershell.exe with NonInteractive and ExecutionPolicy Bypass", async () => {
    const dir = await makeTempDir();
    const ps1 = path.join(dir, "judge.ps1");
    await fs.writeFile(ps1, "Write-Output '{\"score\": 1}'\r\n", "utf8");

    const mocked = mockSpawn(() => ({ stdout: '{"score": 0.8}' }));
    const run = createJudgeScriptRunner({
      commandsEnabled: () => true,
      spawnCommand: mocked.spawnCommand,
      platform: "win32",
      env: {},
    });

    const result = await run({
      ...subject(),
      script: { mode: "command", command: ps1, args: ["-Flag", "val"] },
    });

    expect(result.verdicts).toEqual([{ score: 0.8 }]);
    expect(mocked.calls[0]!.command).toBe("powershell.exe");
    expect(mocked.calls[0]!.args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      realpathSync(ps1),
      "-Flag",
      "val",
    ]);
    expect(mocked.calls[0]!.options).toMatchObject({ shell: false, windowsHide: true });
  });

  it("terminates the Windows process tree via taskkill on timeout and abort, falling back to SIGKILL", async () => {
    let hungChild: EventEmitter | undefined;
    let fallbackKilled = false;
    const timeoutMock = mockSpawn((command) => {
      if (command === "taskkill") {
        return { code: 1 };
      }
      return {
        pid: 43210,
        hang: true,
        onKill: () => { fallbackKilled = true; },
      };
    });
    const wrappedSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      const proc = (timeoutMock.spawnCommand as unknown as (c: string, a: string[], o: Record<string, unknown>) => EventEmitter)(command, args, options);
      if (command !== "taskkill") hungChild = proc;
      return proc;
    }) as never;

    const run = createJudgeScriptRunner({
      commandsEnabled: () => true,
      spawnCommand: wrappedSpawn,
      platform: "win32",
      env: {},
    });

    await expect(run({
      ...subject(),
      script: { mode: "command", command: "judge.exe", timeoutMs: 20 },
    })).rejects.toThrow(/script_timed_out/);

    expect(hungChild).toBeDefined();
    expect(fallbackKilled).toBe(true);
    expect(timeoutMock.calls[1]).toMatchObject({
      command: "taskkill",
      args: ["/PID", "43210", "/T", "/F"],
      options: { shell: false, windowsHide: true, stdio: "ignore" },
    });

    // Also verify AbortSignal triggers taskkill and handles synchronous taskkill failure via SIGKILL fallback.
    let abortFallbackKilled = false;
    const abortCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const abortSpawn = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
      abortCalls.push({ command, args, options });
      if (command === "taskkill") {
        throw new Error("taskkill missing");
      }
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { end: () => void; on: () => void };
        kill: () => boolean;
      };
      child.pid = 9988;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => {}, on: () => {} };
      child.kill = () => {
        abortFallbackKilled = true;
        setImmediate(() => child.emit("close", null));
        return true;
      };
      return child;
    });

    const controller = new AbortController();
    const abortRun = createJudgeScriptRunner({
      commandsEnabled: () => true,
      spawnCommand: abortSpawn as never,
      platform: "win32",
      env: {},
    });
    const pending = abortRun({
      ...subject(),
      signal: controller.signal,
      script: { mode: "command", command: "judge.exe" },
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/script_aborted/);
    expect(abortFallbackKilled).toBe(true);
    expect(abortCalls[1]).toMatchObject({
      command: "taskkill",
      args: ["/PID", "9988", "/T", "/F"],
      options: { shell: false, windowsHide: true },
    });
  });

  it.skipIf(process.platform !== "win32")("executes real Windows .cmd shims, .bat files, and .ps1 scripts end-to-end", async () => {
    const dir = await makeTempDir();
    const binDir = path.join(dir, "bin");
    const target = path.join(dir, "node_modules", "real-judge", "bin", "judge.cjs");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      [
        "let raw = '';",
        "process.stdin.on('data', (c) => { raw += c; });",
        "process.stdin.on('end', () => {",
        "  const parsed = JSON.parse(raw);",
        "  console.log(JSON.stringify({ score: parsed.task.expectedOutput === '4' ? 1 : 0, reason: process.argv.slice(2).join('|') }));",
        "});",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(binDir, "real-judge.CMD"),
      '@ECHO off\r\n"%~dp0\\..\\node_modules\\real-judge\\bin\\judge.cjs" %*\r\n',
      "utf8",
    );
    const bat = path.join(dir, "batch & judge.bat");
    await fs.writeFile(
      bat,
      `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`,
      "utf8",
    );
    const ps1 = path.join(dir, "ps-judge.ps1");
    await fs.writeFile(
      ps1,
      [
        "param([string]$Tag)",
        "$raw = [Console]::In.ReadToEnd()",
        "$obj = $raw | ConvertFrom-Json",
        "$score = if ($obj.task.expectedOutput -eq '4') { 0.9 } else { 0 }",
        "@{ score = $score; reason = $Tag } | ConvertTo-Json -Compress",
      ].join("\r\n"),
      "utf8",
    );

    const run = createJudgeScriptRunner({
      commandsEnabled: () => true,
      env: { ...process.env, PATH: `${binDir};${process.env.PATH ?? ""}` },
    });

    const shimResult = await run({
      ...subject(),
      script: { mode: "command", command: "real-judge", args: ["a & b", "%TEMP%"] },
    });
    expect(shimResult.verdicts).toEqual([{ score: 1, reason: "a & b|%TEMP%" }]);

    const batResult = await run({
      ...subject(),
      script: { mode: "command", command: bat, args: ["100% & safe", 'quote "ok"', "C:\\trail\\"] },
    });
    expect(batResult.verdicts).toEqual([{ score: 1, reason: '100% & safe|quote "ok"|C:\\trail\\' }]);

    const psResult = await run({
      ...subject(),
      script: { mode: "command", command: ps1, args: ["ps-ok"] },
    });
    expect(psResult.verdicts).toEqual([{ score: 0.9, reason: "ps-ok" }]);

    // Verify real process-tree kill terminates child processes spawned by a hanging batch file.
    const pidFile = path.join(dir, "grandchild.pid");
    const sleeperJs = path.join(dir, "sleeper.cjs");
    await fs.writeFile(
      sleeperJs,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      "utf8",
    );
    const hangBat = path.join(dir, "hang-tree.bat");
    await fs.writeFile(
      hangBat,
      `@echo off\r\n"${process.execPath}" "${sleeperJs}"\r\n`,
      "utf8",
    );

    const treeController = new AbortController();
    const hangRun = run({
      ...subject(),
      signal: treeController.signal,
      script: { mode: "command", command: hangBat, timeoutMs: 10_000 },
    });

    let grandchildPid = 0;
    try {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const text = await fs.readFile(pidFile, "utf8").catch(() => "");
        if (text.trim()) {
          grandchildPid = Number(text.trim());
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(grandchildPid).toBeGreaterThan(0);

      treeController.abort();
      await expect(hangRun).rejects.toThrow(/script_aborted/);

      let alive = true;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          process.kill(grandchildPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          alive = false;
          break;
        }
      }
      expect(alive).toBe(false);
    } finally {
      treeController.abort();
      await hangRun.catch(() => undefined);
      if (grandchildPid > 0) {
        try { process.kill(grandchildPid, "SIGKILL"); } catch { /* Already terminated. */ }
      }
    }
  }, 15_000);
});

describe("normalizeJudgeScriptResult", () => {
  it("clamps nothing and keeps the fields a report shows", () => {
    expect(normalizeJudgeScriptResult({
      score: 1.4,
      reason: "over the top",
      evidence: ["line 3"],
      failedCriteria: [],
    })).toEqual([{ score: 1.4, reason: "over the top", evidence: ["line 3"] }]);
  });

  it("rejects an empty list, which is a judge that decided nothing", () => {
    expect(() => normalizeJudgeScriptResult([])).toThrow(/script_returned_no_verdict/);
  });
});
