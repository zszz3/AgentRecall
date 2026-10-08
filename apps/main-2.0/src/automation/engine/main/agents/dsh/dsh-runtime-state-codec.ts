import { asRuntimeStateRecord, createRuntimeStateCodec } from "../runtime/runtime-state-codec";

export interface DshConversationPayload {
  native: { sessionId: string };
}

export const dshRuntimeStateCodec = createRuntimeStateCodec<DshConversationPayload>({
  runtimeId: "dsh",
  decodePayload(raw) {
    const native = asRuntimeStateRecord(asRuntimeStateRecord(raw)?.native);
    const sessionId = native?.sessionId;
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 8_192) return undefined;
    return { native: { sessionId } };
  },
});
