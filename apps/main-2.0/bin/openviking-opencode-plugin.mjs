/**
 * Retired directory Memory OpenCode plugin.
 *
 * Earlier releases wrote `~/.config/opencode/plugins/agent-recall-openviking.js`,
 * which imports this file by absolute URL. Until the desktop app or `uninstall`
 * removes that wrapper, OpenCode still loads it, so this module keeps the
 * export and returns a plugin without hooks. Delete it together with
 * `openviking-memory-hook.cjs`.
 */
export function createAgentRecallOpenVikingPlugin() {
  return async function agentRecallOpenVikingPlugin() {
    return {};
  };
}
