import { SessionStore } from "../session-store";
import { SqliteDatabase } from "./database";
import { SQLITE_MIGRATIONS } from "./schema";

export function createInMemoryStore(attachmentCacheRoot: string | null = null): SessionStore {
  const database = SqliteDatabase.open(":memory:", {
    migrations: SQLITE_MIGRATIONS,
  });
  return new SessionStore(database, database.initialize(), attachmentCacheRoot);
}
