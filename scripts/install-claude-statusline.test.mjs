import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("staging postinstall materializes dependencies without touching Claude settings", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-recall-staged-statusline-"));
  const stageRoot = path.join(home, "stage");
  const packageRoot = path.join(stageRoot, "node_modules", "agent-recall");
  try {
    await mkdir(path.join(packageRoot, "bin"), { recursive: true });
    await mkdir(path.join(stageRoot, "node_modules", "electron-store"), { recursive: true });
    await copyFile(path.resolve("bin/install-claude-statusline.cjs"), path.join(packageRoot, "bin", "install-claude-statusline.cjs"));
    await copyFile(path.resolve("bin/staged-package-dependencies.cjs"), path.join(packageRoot, "bin", "staged-package-dependencies.cjs"));
    await writeFile(path.join(stageRoot, "node_modules", "electron-store", "package.json"), '{"name":"electron-store"}\n');

    await execFileAsync(process.execPath, [path.join(packageRoot, "bin", "install-claude-statusline.cjs")], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENT_RECALL_STAGING_INSTALL: "1",
        AGENT_RECALL_STAGE_ROOT: stageRoot,
      },
    });
    await assert.rejects(readFile(path.join(home, ".claude", "settings.json"), "utf8"), /ENOENT/);
    assert.equal(
      await readFile(path.join(packageRoot, "node_modules", "electron-store", "package.json"), "utf8"),
      '{"name":"electron-store"}\n',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
