import type { MessageBookmark } from "../message-tools";
import type { SessionStoreDatabase } from "./database";

/** Independent of indexed message rows so reindexing does not discard user annotations. */
export class MessageBookmarkStore {
  constructor(private readonly db: SessionStoreDatabase) {}

  list(sessionKey: string): MessageBookmark[] {
    const rows = this.db.prepare(
      "SELECT bookmark FROM message_bookmarks WHERE session_key = ? ORDER BY created_at DESC"
    ).all(sessionKey) as Array<{ bookmark: string }>;
    return rows.map((row) => JSON.parse(row.bookmark) as MessageBookmark);
  }

  save(bookmark: MessageBookmark): void {
    this.db.prepare(
      `INSERT INTO message_bookmarks (session_key, fingerprint, bookmark, created_at, message_index) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_key, message_index, fingerprint) DO UPDATE SET bookmark = excluded.bookmark`
    ).run(bookmark.sessionKey, bookmark.fingerprint, JSON.stringify(bookmark), bookmark.createdAt, bookmark.messageIndex);
  }

  remove(sessionKey: string, fingerprint: string, index: number): void {
    this.db.prepare("DELETE FROM message_bookmarks WHERE session_key = ? AND fingerprint = ? AND message_index = ?").run(sessionKey, fingerprint, index);
  }
}
