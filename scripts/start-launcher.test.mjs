import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../start.sh", import.meta.url), "utf8");
const commandSource = readFileSync(new URL("../bin/agent-recall.cjs", import.meta.url), "utf8");

test("launcher documents and parses local mode", () => {
  assert.match(source, /bash start\.sh local/);
  assert.match(source, /local\|--local\) LOCAL_MODE=true/);
  assert.match(source, /Mode: local checkout \(automatic release update check disabled\)/);
});

test("normal launch still uses the global command", () => {
  assert.match(source, /LAUNCH_BIN="agent-recall"/);
  assert.match(source, /LAUNCH_NO_UPDATE=false/);
});

test("local launch starts this checkout without automatic update checks", () => {
  assert.match(source, /LOCAL_BIN="\$ROOT_DIR\/bin\/agent-recall\.cjs"/);
  assert.match(source, /LAUNCH_BIN="\$LOCAL_BIN"/);
  assert.match(source, /LAUNCH_NO_UPDATE=true/);
  assert.match(source, /AGENT_RECALL_SOURCE_BUILD=1 AGENT_RECALL_NO_UPDATE_CHECK=1 "\$LAUNCH_BIN" --no-update-check/);
});

test("global command marks npm-installed launches as release builds", () => {
  assert.match(commandSource, /environment\.AGENT_RECALL_RELEASE_BUILD = "1"/);
  assert.match(commandSource, /environment\.AGENT_RECALL_SOURCE_BUILD !== "1"/);
});

test("normal launch falls back to a ready Electron runtime after validation errors", () => {
  assert.match(commandSource, /isElectronRuntimeReady/);
  assert.match(commandSource, /try \{\s*await ensureElectronRuntimeForLaunch\(/);
  assert.match(commandSource, /if \(!isElectronRuntimeReady\(packagePath\)\) throw error;/);
  assert.match(commandSource, /继续启动应用/);
});

test("launcher detects installed and local app instances", () => {
  assert.match(source, /APP_PROCESS_FILE="\$HOME\/\.agent-recall\/app-process\.json"/);
  assert.match(source, /USER_DATA_PATTERN="\$HOME\/Library\/Application Support\/AgentRecall"/);
  assert.match(source, /app_process_file_pid\(\)/);
  assert.match(source, /pgrep -f "\$USER_DATA_PATTERN"/);
  assert.match(source, /is_main_process_command/);
  assert.match(source, /append_main_process_pid\(\)/);
});

test("launcher exits with the final app launch status", () => {
  assert.match(source, /launch_agent_recall\r?\nexit \$\?/);
});

test("local mode keeps normal focus and restart behavior", () => {
  assert.match(source, /\[ "\$APP_RUNNING" = true \] && \[ "\$build_needed" = false \]/);
  assert.doesNotMatch(source, /closing it to launch the local checkout/);
});
