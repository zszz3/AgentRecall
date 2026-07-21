import type { InteractiveSessionContext } from "./runtime-driver";

export interface SessionReconfigurePlan {
  applyNow: Partial<InteractiveSessionContext>;
  applyOnNextAttach: Partial<InteractiveSessionContext>;
  invalidateResume: boolean;
  requiresSessionRecreate: boolean;
}

export function planSessionReconfigure(
  current: InteractiveSessionContext,
  next: InteractiveSessionContext,
): SessionReconfigurePlan {
  const applyNow: Partial<InteractiveSessionContext> = {
    configuredAgentId: next.configuredAgentId,
    emit: next.emit,
    ...(next.syncState ? { syncState: next.syncState } : {}),
  };

  const applyOnNextAttach: Partial<InteractiveSessionContext> = {};
  if (current.runtimeConfig.model !== next.runtimeConfig.model) {
    applyOnNextAttach.runtimeConfig = next.runtimeConfig;
  }
  if (current.channelId !== next.channelId) applyOnNextAttach.channelId = next.channelId;
  if (current.developerInstructions !== next.developerInstructions) {
    applyOnNextAttach.developerInstructions = next.developerInstructions;
  }
  if (current.workDir !== next.workDir) applyOnNextAttach.workDir = next.workDir;
  if (current.runtime.command !== next.runtime.command) applyOnNextAttach.runtime = next.runtime;

  const runtimeChanged = current.runtimeId !== next.runtimeId;
  const workDirChanged = current.workDir !== next.workDir;
  const channelChanged = current.channelId !== next.channelId;

  return {
    applyNow,
    applyOnNextAttach,
    invalidateResume: runtimeChanged || workDirChanged || channelChanged,
    requiresSessionRecreate: runtimeChanged,
  };
}
