import { SessionStore } from "../session-store";
import { PostgresDatabase } from "./database";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";

export function createInMemoryStore(attachmentCacheRoot: string | null = null): SessionStore {
  const database = new PostgresDatabase(new PGliteTestPool(), {
    migrationLock: false,
    migrations: POSTGRES_MIGRATIONS,
  });
  return new SessionStore(database, database.initialize(), attachmentCacheRoot);
}
