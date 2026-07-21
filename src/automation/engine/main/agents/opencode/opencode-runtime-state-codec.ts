import { createAcpRuntimeStateCodec, type AcpRuntimeConversationPayload } from "../acp/acp-runtime-state-codec";

export type OpenCodeRuntimeConversationPayload = AcpRuntimeConversationPayload;

export const openCodeRuntimeStateCodec = createAcpRuntimeStateCodec("opencode");
