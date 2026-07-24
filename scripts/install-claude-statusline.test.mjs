import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("statusline postinstall ignores temporary update staging paths", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-recall-staged-statusline-"));
  try {
    await execFileAsync(process.execPath, [path.resolve("bin/install-claude-statusline.cjs")], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENT_RECALL_STAGING_INSTALL: "1",
        AGENT_RECALL_STAGE_ROOT: path.join(home, "stage"),
      },
    });
    await assert.rejects(readFile(path.join(home, ".claude", "settings.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
