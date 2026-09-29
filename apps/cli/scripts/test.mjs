import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedEnvironment } from "./isolated-environment.mjs";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-cli-tests-"));
try {
  const env = isolatedEnvironment(testHome);
  const files = fs.readdirSync("test").filter((name) => name.endsWith(".test.ts")).map((name) => path.join("test", name));
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(testHome, { recursive: true, force: true }); }
