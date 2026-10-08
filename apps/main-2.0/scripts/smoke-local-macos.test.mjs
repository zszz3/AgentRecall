import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./smoke-local-macos.mjs", import.meta.url));

test("unsupported UI quality option fails before bundle access or native launch", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-smoke-cli-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  await fs.mkdir(home);
  await fs.mkdir(tmp);
  // Keep this CLI regression safe even if validation moves after a launch.
  const guard = `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    childProcess.spawn = childProcess.execFileSync = () => {
      throw new Error("Unexpected native launch during CLI validation");
    };
    syncBuiltinESMExports();
  `;
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(guard)}`,
    script, path.join(root, "missing.app"), "--ui-quality",
  ], {
    cwd: root,
    env: { HOME: home, TMPDIR: tmp, PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /--ui-quality is no longer supported; run core smoke without this option\./);
  assert.deepEqual(await fs.readdir(tmp), []);
  assert.deepEqual(await fs.readdir(home), []);
});
