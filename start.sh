#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Agent-Session-Search — smart launcher for macOS
#
# Usage:  bash start.sh          # normal launch, may offer release updates
#         bash start.sh local    # launch this checkout, no release update prompt
#
# • Checks environment & installs missing pieces (first run only)
# • Skips rebuild when source hasn't changed since last build
# • If the app is already running and code is unchanged, just
#   focuses the existing window (instant — no kill, no rebuild)
# • Only rebuilds + restarts when source actually changed
# ─────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

LAUNCH_MODE="${1:-}"
case "$LAUNCH_MODE" in
  "") LOCAL_MODE=false ;;
  local|--local) LOCAL_MODE=true ;;
  -h|--help)
    cat <<'EOF'
Usage:
  sh start.sh          Launch normally through the global command.
  sh start.sh local    Launch this checkout's build and disable release updates.
EOF
    exit 0
    ;;
  *)
    echo "Unknown argument: $LAUNCH_MODE" >&2
    echo "Use: sh start.sh [local]" >&2
    exit 1
    ;;
esac

# Colours -------------------------------------------------------
if [ -t 1 ]; then
  C_BOLD="\033[1m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"
  C_RED="\033[31m"; C_CYAN="\033[36m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_DIM=""; C_RESET=""
fi

info()  { printf "${C_CYAN}▸ %s${C_RESET}\n" "$*"; }
ok()    { printf "${C_GREEN}✓ %s${C_RESET}\n" "$*"; }
warn()  { printf "${C_YELLOW}⚠ %s${C_RESET}\n" "$*"; }
fail()  { printf "${C_RED}✗ %s${C_RESET}\n" "$*" >&2; exit 1; }

printf "%b\n" "${C_BOLD}Agent-Session-Search launcher${C_RESET}"
if [ "$LOCAL_MODE" = true ]; then
  echo "Mode: local checkout (release update prompt disabled)"
else
  echo "Mode: normal global launch"
fi
echo ""

# ── 1. Node.js ≥ 22.13 ─────────────────────────────────────────
node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major minor
  major="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null)"
  minor="$(node -e 'process.stdout.write(process.versions.node.split(".")[1])' 2>/dev/null)"
  [ -n "$major" ] && [ -n "$minor" ] || return 1
  if [ "$major" -gt 22 ]; then return 0; fi
  if [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; then return 0; fi
  return 1
}

if node_version_ok; then
  ok "Node.js $(node --version) detected"
else
  warn "Node.js 22.13+ not found in PATH"

  NVM_SH="$HOME/.nvm/nvm.sh"
  if [ -s "$NVM_SH" ]; then
    info "Loading nvm …"
    # shellcheck disable=SC1090
    . "$NVM_SH" >/dev/null 2>&1

    if command -v nvm >/dev/null 2>&1; then
      info "Installing Node 22 via nvm (first time may take a minute) …"
      nvm install 22 >/dev/null 2>&1 || fail "nvm install 22 failed"
      nvm use 22 >/dev/null 2>&1 || fail "nvm use 22 failed"
      ok "Node.js $(node --version) ready via nvm"
    else
      fail "nvm found but did not load. Run 'nvm install 22 && nvm use 22' manually, then re-run start.sh"
    fi
  else
    fail "Node.js 22.13+ is required but not installed, and nvm was not found.
       Install Node.js 22.13+ from https://nodejs.org or install nvm first:
         curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
       Then re-run start.sh"
  fi
fi

# ── 2. npm available ───────────────────────────────────────────
command -v npm >/dev/null 2>&1 || fail "npm not found after Node check."
ok "npm $(npm --version) detected"

# ── 3. dependencies (node_modules) ─────────────────────────────
if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
  ok "Dependencies installed (node_modules/ exists)"
else
  info "Installing dependencies (npm ci) — first run may take a few minutes …"
  npm ci || fail "npm ci failed"
  ok "Dependencies installed"
fi

# ── 4. build output (out/) — skip if up-to-date ────────────────
# Track the newest source mtime in a sentinel file (.build-sentinel).
# After each successful build we store that mtime; on the next run we
# recompute the newest source mtime and compare. If no source file is
# newer than the sentinel (and build outputs exist), we skip the rebuild.
# This is more reliable than comparing source-vs-output mtimes because
# Vite does not rewrite asset files whose content hash is unchanged.
SENTINEL="$ROOT_DIR/.build-sentinel"

newest_source=0
for f in \
  $(find src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.html' \) 2>/dev/null) \
  electron.vite.config.ts tsconfig.json package.json \
  scripts/build-mcp-bundle.mjs bin/agent-session-search-mcp.mjs bin/setup-mcp.cjs; do
  [ -f "$f" ] || continue
  m=$(stat -f '%m' "$f" 2>/dev/null || echo 0)
  [ "$m" -gt "$newest_source" ] && newest_source="$m"
done

# Build outputs must all exist.
outputs_exist=true
for f in \
  out/main/index.js out/preload/index.mjs out/renderer/index.html \
  out/mcp/migration-entry.js; do
  [ -f "$f" ] || { outputs_exist=false; break; }
done
ls out/renderer/assets/*.js >/dev/null 2>&1 || outputs_exist=false
ls out/renderer/assets/*.css >/dev/null 2>&1 || outputs_exist=false

last_built=0
[ -f "$SENTINEL" ] && last_built=$(cat "$SENTINEL" 2>/dev/null || echo 0)

if [ "$outputs_exist" = true ] && [ "$newest_source" -le "$last_built" ]; then
  ok "Build is up to date — skipping rebuild"
  build_needed=false
else
  info "Source changed (or no build found) — rebuilding …"
  npm run build || fail "npm run build failed"
  echo "$newest_source" > "$SENTINEL"
  ok "Build complete"
  build_needed=true
fi

# ── 5. global command ──────────────────────────────────────────
# Verify that every bin entry declared in package.json is linked in the
# global bin dir. If any are missing (e.g. new bin entries added since the
# last global install), re-run npm install -g . to refresh the symlinks.
GLOBAL_PREFIX="$(npm prefix -g 2>/dev/null)"
GLOBAL_BIN="$GLOBAL_PREFIX/bin/agent-session-search"
LOCAL_BIN="$ROOT_DIR/bin/agent-session-search.cjs"
all_bins_linked=true
if [ -x "$GLOBAL_BIN" ]; then
  linked_target="$(node -e 'const fs=require("fs"), path=require("path"); try { process.stdout.write(fs.realpathSync(process.argv[1])); } catch { process.stdout.write(""); }' "$GLOBAL_BIN")"
  local_target="$(node -e 'const fs=require("fs"), path=require("path"); try { process.stdout.write(fs.realpathSync(process.argv[1])); } catch { process.stdout.write(""); }' "$LOCAL_BIN")"
  if [ "$linked_target" != "$local_target" ]; then
    all_bins_linked=false
  fi
  for bin_name in \
    agent-session-search \
    agent-session-search-claude-statusline \
    agent-session-search-setup-claude-statusline \
    agent-session-search-skill-usage \
    agent-session-search-setup-skill-usage-hook \
    agent-session-search-mcp \
    agent-session-search-setup-mcp; do
    if [ ! -x "$GLOBAL_PREFIX/bin/$bin_name" ]; then
      all_bins_linked=false
      break
    fi
  done
else
  all_bins_linked=false
fi

if [ "$all_bins_linked" = true ]; then
  ok "Global command 'agent-session-search' registered"
else
  info "Registering / refreshing global command (npm install -g .) …"
  npm install -g . || fail "npm install -g . failed"
  ok "Global command registered"
fi

if [ "$LOCAL_MODE" = true ]; then
  LAUNCH_BIN="$LOCAL_BIN"
  LAUNCH_NO_UPDATE=true
else
  LAUNCH_BIN="agent-session-search"
  LAUNCH_NO_UPDATE=false
fi

launch_agent_session_search() {
  if [ "$LAUNCH_NO_UPDATE" = true ]; then
    AGENT_SESSION_SEARCH_NO_UPDATE_CHECK=1 "$LAUNCH_BIN" --no-update-check "$@"
  else
    "$LAUNCH_BIN" "$@"
  fi
}

# ── 6. register MCP server (skip if already registered) ────────
SETUP_MCP="$(npm prefix -g 2>/dev/null)/bin/agent-session-search-setup-mcp"
if [ -x "$SETUP_MCP" ]; then
  if "$SETUP_MCP" --status >/dev/null 2>&1; then
    ok "MCP server already registered"
  else
    info "Registering MCP server in Claude Code / Codex …"
    "$SETUP_MCP" || warn "MCP registration failed (non-fatal — run 'agent-session-search-setup-mcp' manually later)"
    ok "MCP server registered"
  fi
else
  warn "setup-mcp command not found — MCP server not registered. Run 'node bin/setup-mcp.cjs' manually after install."
fi

# ── 7. launch ──────────────────────────────────────────────────
# The Electron app uses requestSingleInstanceLock: launching the
# binary a second time focuses the existing window and the new
# process exits immediately. We use this to our advantage:
#
# • App running + no rebuild  → just re-launch (focuses window,
#   new process exits instantly). No kill, no restart.
# • App running + rebuilt     → kill old instance, then launch.
# • App not running           → just launch.
#
# Process detection: the Electron main process appears as
#   <repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
# Helper sub-processes contain "--type=" in their command line, so we
# exclude those to avoid false positives.
ELECTRON_PATTERN="$ROOT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
APP_PROCESS_FILE="$HOME/.agent-session-search/app-process.json"
USER_DATA_PATTERN="$HOME/Library/Application Support/Agent-Session-Search"

is_main_process_command() {
  case "$1" in
    *"--type="*) return 1 ;;
    *"agent-session-search-mcp"*) return 1 ;;
    *) return 0 ;;
  esac
}

is_pid_running() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

app_process_file_pid() {
  [ -f "$APP_PROCESS_FILE" ] || return 0
  node -e 'try { const entry = require(process.argv[1]); const pid = Number(entry && entry.pid); if (Number.isInteger(pid) && pid > 0) process.stdout.write(String(pid)); } catch {}' "$APP_PROCESS_FILE" 2>/dev/null || true
}

append_main_process_pid() {
  local pid command
  pid="$1"
  [ -n "$pid" ] || return 0
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if is_main_process_command "$command"; then
    printf '%s\n' "$pid"
  fi
}

app_is_running() {
  local state_pid pid
  state_pid="$(app_process_file_pid)"
  if is_pid_running "$state_pid"; then
    append_main_process_pid "$state_pid"
  fi

  for pid in $(pgrep -f "$ELECTRON_PATTERN" 2>/dev/null || true); do
    append_main_process_pid "$pid"
  done

  for pid in $(pgrep -f "$USER_DATA_PATTERN" 2>/dev/null || true); do
    append_main_process_pid "$pid"
  done
}

APP_PID=$(app_is_running || true)
APP_RUNNING=false
[ -n "$APP_PID" ] && APP_RUNNING=true

if [ "$APP_RUNNING" = true ] && [ "$build_needed" = false ] && [ "$LOCAL_MODE" = false ]; then
  # App is running and code is unchanged — just focus it.
  ok "App is already running — focusing existing window"
  echo ""
  launch_agent_session_search 2>/dev/null || true
  exit 0
fi

if [ "$APP_RUNNING" = true ]; then
  if [ "$LOCAL_MODE" = true ]; then
    info "Existing instance found — closing it to launch the local checkout …"
  else
    info "Existing instance found — closing it to apply updates …"
  fi
  for pid in $APP_PID; do
    kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 20); do
    [ -z "$(app_is_running)" ] && break
    sleep 0.25
  done
  ok "Previous instance closed"
fi

echo ""
info "Launching Agent-Session-Search …"
printf "    %b\n" "${C_DIM}(The app runs in the menu bar — press Option+Space to show the window)${C_RESET}"
echo ""
launch_agent_session_search
exit $?
