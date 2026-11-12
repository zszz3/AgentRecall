#!/usr/bin/env node
"use strict";

/**
 * Retired directory Memory hook entry point.
 *
 * Earlier releases registered `node <install>/bin/openviking-memory-hook.cjs`
 * in Claude Code and Codex settings. After an upgrade those entries remain
 * until the desktop app or `uninstall` runs `remove-legacy-memory-hooks.cjs`;
 * this stub keeps them from failing on every prompt in the meantime. It reads
 * and writes nothing and always exits 0. Delete it, together with
 * `openviking-opencode-plugin.mjs`, once no supported upgrade path starts from
 * a release that installed these hooks.
 */
process.exitCode = 0;
