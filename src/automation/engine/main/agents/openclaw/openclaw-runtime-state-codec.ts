import { createAcpRuntimeStateCodec, type AcpRuntimeConversationPayload } from "../acp/acp-runtime-state-codec";

export type OpenClawRuntimeConversationPayload = AcpRuntimeConversationPayload;

export const openClawRuntimeStateCodec = createAcpRuntimeStateCodec("openclaw");
