import type { RuntimeConversation } from "../../../../shared/types";
import { claudeRuntimeStateCodec } from "../../../agents/claude/claude-runtime-state-codec";
import { codexRuntimeStateCodec } from "../../../agents/codex/codex-runtime-state-codec";

export function codexThreadIdFromConversation(conversation?: RuntimeConversation): string | undefined {
  return codexRuntimeStateCodec.decodeConversation(conversation)?.native.threadId;
}

export function claudeSessionIdFromConversation(conversation?: RuntimeConversation): string | undefined {
  return claudeRuntimeStateCodec.decodeConversation(conversation)?.native.sessionId;
}

export function cloneCodexRuntimeConversation(conversation: RuntimeConversation): RuntimeConversation {
  const cloned = codexRuntimeStateCodec.cloneConversation(conversation);
  if (!cloned) {
    throw new Error(`Invalid ${conversation.runtimeId} runtime conversation envelope.`);
  }
  return cloned;
}

export function cloneClaudeRuntimeConversation(conversation: RuntimeConversation): RuntimeConversation {
  const cloned = claudeRuntimeStateCodec.cloneConversation(conversation);
  if (!cloned) {
    throw new Error(`Invalid ${conversation.runtimeId} runtime conversation envelope.`);
  }
  return cloned;
}
