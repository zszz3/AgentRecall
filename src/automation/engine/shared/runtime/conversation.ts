import type { RuntimeId } from "../runtime-catalog";

export interface RuntimeConversation {
  runtimeId: RuntimeId;
  codecVersion: string;
  payload: unknown;
}
