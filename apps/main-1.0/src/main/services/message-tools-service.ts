import { createHash, randomUUID } from "node:crypto";
import type { SessionStore } from "../../core/session-store";
import type { SessionMessage, SessionMatchHit } from "../../core/types";
import { formatSessionMarkdown, formatSessionPlainText } from "../../core/format-session";
import {
  addCustomRedactions, applyRedactions, findRedactions, messageLink, parseMessageLocator,
  type ExportReview, type MessageLocator, type RedactionChoice, type ReviewExportFormat,
} from "../../core/message-tools";

const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const PREVIEW_LIFETIME_MS = 10 * 60 * 1000;

export class MessageToolsService {
  private readonly reviews = new Map<number, { review: ExportReview; expires: number }>();
  private readonly requests = new Map<number, symbol>();

  constructor(private readonly store: SessionStore, private readonly ensureDetails: (key: string) => Promise<void>) {}

  async locate(sessionKey: string, index: number): Promise<MessageLocator> {
    if (typeof sessionKey !== "string" || !sessionKey || sessionKey.length > 2048
      || !Number.isSafeInteger(index) || index < 0) throw new Error("Invalid message location.");
    await this.ensureDetails(sessionKey);
    const message = (await this.store.getAllMessages(sessionKey)).find((item) => item.index === index);
    if (!message) throw new Error("This message is no longer available. Refresh the conversation.");
    return { sessionKey, messageIndex: index, fingerprint: this.fingerprint(message) };
  }

  private fingerprint(message: SessionMessage): string {
    return createHash("sha256").update(JSON.stringify([message.role, message.timestamp, message.content])).digest("hex");
  }

  async listBookmarks(sessionKey: string) {
    const bookmarks = await this.store.listMessageBookmarks(sessionKey);
    if (bookmarks.length === 0) return bookmarks;
    await this.ensureDetails(sessionKey);
    const messages = (await this.store.getAllMessages(sessionKey)).map((message) => ({
      index: message.index, fingerprint: this.fingerprint(message),
    }));
    return bookmarks.map((bookmark) => {
      const exact = messages.find((message) => message.index === bookmark.messageIndex && message.fingerprint === bookmark.fingerprint);
      const matches = exact ? [exact] : messages.filter((message) => message.fingerprint === bookmark.fingerprint);
      return { ...bookmark, resolvedMessageIndex: matches.length === 1 ? matches[0].index : null };
    });
  }

  async resolve(value: unknown): Promise<{ sessionKey: string; hit: SessionMatchHit }> {
    const locator = parseMessageLocator(value);
    if (!await this.store.getSession(locator.sessionKey)) throw new Error("This session is unavailable on this device.");
    await this.ensureDetails(locator.sessionKey);
    const messages = await this.store.getAllMessages(locator.sessionKey);
    let message = messages.find((item) => item.index === locator.messageIndex && this.fingerprint(item) === locator.fingerprint);
    if (!message) {
      const matches = messages.filter((item) => this.fingerprint(item) === locator.fingerprint);
      if (matches.length === 1) message = matches[0];
    }
    if (!message) throw new Error("The bookmarked message changed or was removed. Open the session to find it again.");
    return { sessionKey: locator.sessionKey, hit: {
      messageIndex: message.index, role: message.role, timestamp: message.timestamp,
      snippet: message.content.slice(0, 240), matchedTerms: [],
    } };
  }

  async copyLink(sessionKey: string, index: number): Promise<string> {
    return messageLink(await this.locate(sessionKey, index));
  }

  async setBookmark(sessionKey: string, index: number, saved: boolean): Promise<void> {
    if (typeof saved !== "boolean") throw new Error("Invalid bookmark state.");
    const locator = await this.locate(sessionKey, index);
    if (!saved) { await this.store.removeMessageBookmark(locator); return; }
    const session = await this.store.getSession(sessionKey);
    if (!session) throw new Error("Session not found.");
    const { hit } = await this.resolve(locator);
    await this.store.saveMessageBookmark({ ...locator, title: session.displayTitle, excerpt: hit.snippet, createdAt: Date.now() });
  }

  async prepareExport(owner: number, sessionKey: string, format: ReviewExportFormat): Promise<ExportReview> {
    if (typeof sessionKey !== "string" || sessionKey.length > 2048 || !["markdown", "text"].includes(format)) throw new Error("Invalid export request.");
    this.release(owner);
    const request = Symbol();
    this.requests.set(owner, request);
    const session = await this.store.getSession(sessionKey);
    if (!session) throw new Error("Session not found.");
    await this.ensureDetails(sessionKey);
    const messages = await this.store.getAllMessages(sessionKey);
    const traces = await this.store.getTraceEvents(sessionKey);
    const text = format === "markdown" ? formatSessionMarkdown(session, messages, traces)
      : formatSessionPlainText(session, messages, traces);
    if (Buffer.byteLength(text) > MAX_EXPORT_BYTES) throw new Error("This conversation exceeds the 8 MB preview limit.");
    const review: ExportReview = { id: randomUUID(), text, findings: findRedactions(text), format };
    if (this.requests.get(owner) !== request) throw new Error("Export preview was closed or replaced.");
    this.reviews.set(owner, { review, expires: Date.now() + PREVIEW_LIFETIME_MS });
    return review;
  }

  addCustom(owner: number, id: string, value: string): ExportReview {
    const review = this.getReview(owner, id);
    if (typeof value !== "string") throw new Error("Invalid custom text.");
    review.findings = addCustomRedactions(review.text, review.findings, value);
    return review;
  }

  exportContent(owner: number, id: string, choices: RedactionChoice[]): { text: string; extension: string } {
    const review = this.getReview(owner, id);
    const text = applyRedactions(review.text, review.findings, choices);
    if (Buffer.byteLength(text) > MAX_EXPORT_BYTES) throw new Error("The reviewed export exceeds 8 MB.");
    return { text, extension: review.format === "markdown" ? "md" : "txt" };
  }

  private getReview(owner: number, id: string): ExportReview {
    const entry = this.reviews.get(owner);
    if (!entry || entry.review.id !== id || entry.expires < Date.now()) {
      if (entry?.review.id === id) this.release(owner);
      throw new Error("Export preview expired. Open a new preview.");
    }
    return entry.review;
  }

  release(owner: number): void { this.requests.delete(owner); this.reviews.delete(owner); }
}
