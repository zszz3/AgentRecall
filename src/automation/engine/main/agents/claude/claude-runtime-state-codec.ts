import {
  asOptionalRuntimeStateStringArray,
  asRuntimeStateRecord,
  asRuntimeStateString,
  cloneRuntimeStateValue,
  createRuntimeStateCodec,
} from "../runtime/runtime-state-codec";

export interface ClaudeRuntimeConversationPayload {
  native: {
    sessionId: string;
    projectKey?: string;
    subpaths?: string[];
  };
  appContext?: {
    cwd?: string;
    modelId?: string;
    claudeConfigDir?: string;
    sessionStoreRef?: string;
  };
  extensions?: Record<string, unknown>;
}

function decodeClaudePayload(raw: unknown): ClaudeRuntimeConversationPayload | undefined {
  const record = asRuntimeStateRecord(raw);
  const native = asRuntimeStateRecord(record?.native);
  const sessionId = asRuntimeStateString(native?.sessionId);
  if (!sessionId) return undefined;
  if (native && Object.prototype.hasOwnProperty.call(native, "projectKey") && typeof native.projectKey !== "string") {
    return undefined;
  }
  if (
    native
    && Object.prototype.hasOwnProperty.call(native, "subpaths")
    && asOptionalRuntimeStateStringArray(native.subpaths) === undefined
  ) {
    return undefined;
  }
  const projectKey = asRuntimeStateString(native?.projectKey);
  const subpaths = asOptionalRuntimeStateStringArray(native?.subpaths);
  const appContext = asRuntimeStateRecord(record?.appContext);
  const extensions = asRuntimeStateRecord(record?.extensions);
  if (record?.appContext !== undefined && !appContext) return undefined;
  if (record?.extensions !== undefined && !extensions) return undefined;
  if (
    appContext
    && ((Object.prototype.hasOwnProperty.call(appContext, "cwd") && typeof appContext.cwd !== "string")
      || (Object.prototype.hasOwnProperty.call(appContext, "modelId") && typeof appContext.modelId !== "string")
      || (Object.prototype.hasOwnProperty.call(appContext, "claudeConfigDir") && typeof appContext.claudeConfigDir !== "string")
      || (Object.prototype.hasOwnProperty.call(appContext, "sessionStoreRef") && typeof appContext.sessionStoreRef !== "string"))
  ) {
    return undefined;
  }
  const cwd = asRuntimeStateString(appContext?.cwd);
  const modelId = asRuntimeStateString(appContext?.modelId);
  const claudeConfigDir = asRuntimeStateString(appContext?.claudeConfigDir);
  const sessionStoreRef = asRuntimeStateString(appContext?.sessionStoreRef);
  return {
    native: {
      sessionId,
      ...(projectKey !== undefined ? { projectKey } : {}),
      ...(subpaths !== undefined ? { subpaths } : {}),
    },
    ...(appContext
      ? {
          appContext: {
            ...(cwd !== undefined ? { cwd } : {}),
            ...(modelId !== undefined ? { modelId } : {}),
            ...(claudeConfigDir !== undefined ? { claudeConfigDir } : {}),
            ...(sessionStoreRef !== undefined ? { sessionStoreRef } : {}),
          },
        }
      : {}),
    ...(extensions ? { extensions: cloneRuntimeStateValue(extensions) } : {}),
  };
}

export const claudeRuntimeStateCodec = createRuntimeStateCodec<ClaudeRuntimeConversationPayload>({
  runtimeId: "claude",
  decodePayload: decodeClaudePayload,
});
