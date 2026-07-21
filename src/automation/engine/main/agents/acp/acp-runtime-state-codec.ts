import type { AgentId } from "../../../shared/types";
import {
  asRuntimeStateRecord,
  asRuntimeStateString,
  cloneRuntimeStateValue,
  createRuntimeStateCodec,
  type RuntimeStateCodec,
} from "../runtime/runtime-state-codec";

export interface AcpRuntimeConversationPayload {
  native: {
    sessionId: string;
  };
  appContext?: {
    cwd?: string;
    modelId?: string;
    transport?: "acp";
  };
  extensions?: Record<string, unknown>;
}

function decodeAcpPayload(raw: unknown): AcpRuntimeConversationPayload | undefined {
  const record = asRuntimeStateRecord(raw);
  const native = asRuntimeStateRecord(record?.native);
  const sessionId = asRuntimeStateString(native?.sessionId);
  if (!sessionId) return undefined;
  const appContext = asRuntimeStateRecord(record?.appContext);
  const extensions = asRuntimeStateRecord(record?.extensions);
  if (record?.appContext !== undefined && !appContext) return undefined;
  if (record?.extensions !== undefined && !extensions) return undefined;
  if (
    appContext
    && ((Object.prototype.hasOwnProperty.call(appContext, "cwd") && typeof appContext.cwd !== "string")
      || (Object.prototype.hasOwnProperty.call(appContext, "modelId") && typeof appContext.modelId !== "string")
      || (Object.prototype.hasOwnProperty.call(appContext, "transport") && appContext.transport !== "acp"))
  ) {
    return undefined;
  }
  const cwd = asRuntimeStateString(appContext?.cwd);
  const modelId = asRuntimeStateString(appContext?.modelId);
  const transport = appContext?.transport === "acp" ? "acp" as const : undefined;
  return {
    native: { sessionId },
    ...(appContext
      ? {
          appContext: {
            ...(cwd !== undefined ? { cwd } : {}),
            ...(modelId !== undefined ? { modelId } : {}),
            ...(transport !== undefined ? { transport } : {}),
          },
        }
      : {}),
    ...(extensions ? { extensions: cloneRuntimeStateValue(extensions) } : {}),
  };
}

export function createAcpRuntimeStateCodec(runtimeId: AgentId): RuntimeStateCodec<AcpRuntimeConversationPayload> {
  return createRuntimeStateCodec({
    runtimeId,
    decodePayload: decodeAcpPayload,
  });
}
