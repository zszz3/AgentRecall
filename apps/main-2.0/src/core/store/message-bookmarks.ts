import type { MessageBookmark } from "../message-tools";
import type { PostgresQueryable } from "../postgres/database";

/** Independent of indexed message rows so reindexing does not discard user annotations. */
export class MessageBookmarkStore {
  constructor(private readonly db: PostgresQueryable) {}

  async list(sessionKey: string): Promise<MessageBookmark[]> {
    const result = await this.db.query<{ bookmark: MessageBookmark }>(
      "select bookmark from agent_recall.message_bookmarks where session_key = $1 order by created_at desc",
      [sessionKey]);
    return result.rows.map((row) => row.bookmark);
  }

  async save(bookmark: MessageBookmark): Promise<void> {
    await this.db.query(
      `insert into agent_recall.message_bookmarks (session_key, fingerprint, bookmark, created_at, message_index)
       values ($1, $2, $3::jsonb, $4, $5)
       on conflict (session_key, message_index, fingerprint) do update set bookmark = excluded.bookmark`,
      [bookmark.sessionKey, bookmark.fingerprint, JSON.stringify(bookmark), bookmark.createdAt, bookmark.messageIndex]);
  }

  async remove(sessionKey: string, fingerprint: string, index: number): Promise<void> {
    await this.db.query("delete from agent_recall.message_bookmarks where session_key = $1 and fingerprint = $2 and message_index = $3", [sessionKey, fingerprint, index]);
  }
}
