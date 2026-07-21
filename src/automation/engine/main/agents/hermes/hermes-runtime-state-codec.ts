import { createAcpRuntimeStateCodec, type AcpRuntimeConversationPayload } from "../acp/acp-runtime-state-codec";

export type HermesRuntimeConversationPayload = AcpRuntimeConversationPayload;

export const hermesRuntimeStateCodec = createAcpRuntimeStateCodec("hermes");
