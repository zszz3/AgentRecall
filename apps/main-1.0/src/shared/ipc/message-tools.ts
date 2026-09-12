import type { ExportReview, MessageBookmark, MessageLocator, RedactionChoice, ReviewExportFormat } from "../../core/message-tools";
import type { SessionMatchHit } from "../../core/types";

export const MESSAGE_TOOLS_CHANNELS = {
  list: "message-tools:list", set: "message-tools:set", remove: "message-tools:remove",
  copyLink: "message-tools:copy-link", resolve: "message-tools:resolve",
  pending: "message-tools:pending", open: "message-tools:open", prepare: "message-tools:prepare",
  custom: "message-tools:custom", save: "message-tools:save", release: "message-tools:release",
} as const;

export interface MessageToolsApi {
  list(sessionKey: string): Promise<MessageBookmark[]>;
  set(sessionKey: string, index: number, saved: boolean): Promise<void>;
  remove(locator: MessageLocator): Promise<void>;
  copyLink(sessionKey: string, index: number): Promise<void>;
  resolve(locator: MessageLocator): Promise<{ sessionKey: string; hit: SessionMatchHit }>;
  takePending(): Promise<MessageLocator | null>;
  open(locator: MessageLocator): Promise<void>;
  onOpen(callback: () => void): () => void;
  prepare(sessionKey: string, format: ReviewExportFormat): Promise<ExportReview>;
  addCustom(id: string, value: string): Promise<ExportReview>;
  save(id: string, choices: RedactionChoice[]): Promise<boolean>;
  release(): Promise<void>;
}
