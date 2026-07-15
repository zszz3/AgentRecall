import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../start.sh", import.meta.url), "utf8");

test("launcher documents and parses local mode", () => {
  assert.match(source, /bash start\.sh local/);
  assert.match(source, /local\|--local\) LOCAL_MODE=true/);
  assert.match(source, /Mode: local checkout \(release update prompt disabled\)/);
});

test("normal launch still uses the global command", () => {
  assert.match(source, /LAUNCH_BIN="agent-session-search"/);
  assert.match(source, /LAUNCH_NO_UPDATE=false/);
});

test("local launch starts this checkout without update checks", () => {
  assert.match(source, /LOCAL_BIN="\$ROOT_DIR\/bin\/agent-session-search\.cjs"/);
  assert.match(source, /LAUNCH_BIN="\$LOCAL_BIN"/);
  assert.match(source, /LAUNCH_NO_UPDATE=true/);
  assert.match(source, /AGENT_SESSION_SEARCH_NO_UPDATE_CHECK=1 "\$LAUNCH_BIN" --no-update-check/);
});

test("launcher detects installed and local app instances", () => {
  assert.match(source, /APP_PROCESS_FILE="\$HOME\/\.agent-session-search\/app-process\.json"/);
  assert.match(source, /USER_DATA_PATTERN="\$HOME\/Library\/Application Support\/Agent-Session-Search"/);
  assert.match(source, /app_process_file_pid\(\)/);
  assert.match(source, /pgrep -f "\$USER_DATA_PATTERN"/);
  assert.match(source, /is_main_process_command/);
  assert.match(source, /append_main_process_pid\(\)/);
});

test("launcher exits with the final app launch status", () => {
  assert.match(source, /launch_agent_session_search\nexit \$\?/);
});

test("local mode restarts an existing app instead of focusing a stale install", () => {
  assert.match(source, /\[ "\$APP_RUNNING" = true \] && \[ "\$build_needed" = false \] && \[ "\$LOCAL_MODE" = false \]/);
  assert.match(source, /closing it to launch the local checkout/);
});
