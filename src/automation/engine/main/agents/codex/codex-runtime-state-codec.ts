import {
  asRuntimeStateRecord,
  asRuntimeStateString,
  cloneRuntimeStateValue,
  createRuntimeStateCodec,
} from "../runtime/runtime-state-codec";

export interface CodexRuntimeConversationPayload {
  native: {
    threadId: string;
    sessionTreeRootId?: string;
  };
  appContext?: {
    cwd?: string;
    modelId?: string;
    approvalPolicy?: string;
    sandboxPolicy?: unknown;
  };
  extensions?: Record<string, unknown>;
}

function decodeCodexPayload(raw: unknown): CodexRuntimeConversationPayload | undefined {
  const record = asRuntimeStateRecord(raw);
  const native = asRuntimeStateRecord(record?.native);
  const threadId = asRuntimeStateString(native?.threadId);
  if (!threadId) return undefined;
  if (native && Object.prototype.hasOwnProperty.call(native, "sessionTreeRootId") && typeof native.sessionTreeRootId !== "string") {
    return undefined;
  }
  const sessionTreeRootId = asRuntimeStateString(native?.sessionTreeRootId);
  const appContext = asRuntimeStateRecord(record?.appContext);
  const extensions = asRuntimeStateRecord(record?.extensions);
  if (record?.appContext !== undefined && !appContext) return undefined;
  if (record?.extensions !== undefined && !extensions) return undefined;
  if (
    appContext
    && ((Object.prototype.hasOwnProperty.call(appContext, "cwd") && typeof appContext.cwd !== "string")
      || (Object.prototype.hasOwnProperty.call(appContext, "modelId") && typeof appContext.modelId !== "string")
      || (Object.prototype.hasOwnProperty.call(appContext, "approvalPolicy") && typeof appContext.approvalPolicy !== "string"))
  ) {
    return undefined;
  }
  const cwd = asRuntimeStateString(appContext?.cwd);
  const modelId = asRuntimeStateString(appContext?.modelId);
  const approvalPolicy = asRuntimeStateString(appContext?.approvalPolicy);
  return {
    native: {
      threadId,
      ...(sessionTreeRootId !== undefined ? { sessionTreeRootId } : {}),
    },
    ...(appContext
      ? {
          appContext: {
            ...(cwd !== undefined ? { cwd } : {}),
            ...(modelId !== undefined ? { modelId } : {}),
            ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
            ...(Object.prototype.hasOwnProperty.call(appContext, "sandboxPolicy")
              ? { sandboxPolicy: cloneRuntimeStateValue(appContext.sandboxPolicy) }
              : {}),
          },
        }
      : {}),
    ...(extensions ? { extensions: cloneRuntimeStateValue(extensions) } : {}),
  };
}

export const codexRuntimeStateCodec = createRuntimeStateCodec<CodexRuntimeConversationPayload>({
  runtimeId: "codex",
  decodePayload: decodeCodexPayload,
});
