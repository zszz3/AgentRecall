import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatRuntimeSessionState,
  RuntimeConversation,
} from "../../../shared/types";

export class ChatState {
  readonly kind = "chat";
  id: string = randomUUID();
  title: string;
  channelId: string | undefined = undefined;
  runtimeState: ChatRuntimeSessionState | undefined = undefined;
  runtimeConversation: RuntimeConversation | undefined = undefined;
  developerInstructions: string | undefined = undefined;
  contextDocument: string | undefined = undefined;
  running = false;
  messages: ChatMessage[] = [];
  pendingAssistantMessageId: string | undefined = undefined;
  lastError: string | undefined = undefined;
  createdAt = Date.now();
  updatedAt = this.createdAt;

  constructor(
    public configuredAgentId: string,
    public modelId: string,
    title = "New Chat",
  ) {
    this.title = title;
  }
}
