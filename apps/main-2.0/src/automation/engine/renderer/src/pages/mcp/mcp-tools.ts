import type { McpServerDefinition } from "../../../../shared/mcp/types";

/** Number of tools that are currently enabled (not in the disabled list). */
export function enabledToolCount(
  server: Pick<McpServerDefinition, "tools" | "disabledTools">,
): number {
  const disabled = new Set(server.disabledTools ?? []);
  return server.tools.filter((tool) => !disabled.has(tool.name)).length;
}

/**
 * Compact "enabled/total tools" label. Shows a single number when nothing is
 * disabled, and "enabled/total" once some tools are turned off.
 */
export function toolCountLabel(
  server: Pick<McpServerDefinition, "tools" | "disabledTools">,
  word: string,
): string {
  const total = server.tools.length;
  const enabled = enabledToolCount(server);
  return enabled === total ? `${total} ${word}` : `${enabled}/${total} ${word}`;
}
