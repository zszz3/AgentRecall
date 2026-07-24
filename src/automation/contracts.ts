/**
 * Stable host-facing contract for the imported Automation engine.
 *
 * Main, preload, and renderer code should depend on this module for shared
 * protocol types. Engine-internal paths remain free to follow upstream layout
 * without leaking that layout across the rest of AgentRecall.
 */
export type * from "./engine/shared/types";
export type { ResolveRuntimeApprovalRequest } from "./engine/shared/runtime-approval";
export type { McpServerDefinition } from "./engine/shared/mcp/types";
