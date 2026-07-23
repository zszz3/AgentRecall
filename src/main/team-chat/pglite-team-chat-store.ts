import { PGlite } from "@electric-sql/pglite";
import {
  PostgresTeamChatStore,
  type TeamChatClientLike,
  type TeamChatPoolLike,
  type TeamChatQueryResult,
} from "./postgres-team-chat-store";

interface PGliteQueryLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; affectedRows?: number }>;
  close(): Promise<void>;
  readonly closed: boolean;
}

class SerializedPGlitePool implements TeamChatPoolLike {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly database: PGliteQueryLike) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<TeamChatQueryResult<Row>> {
    const release = await this.acquire();
    try {
      return toQueryResult(await this.database.query<Row>(text, values));
    } finally {
      release();
    }
  }

  async connect(): Promise<TeamChatClientLike> {
    const releaseLock = await this.acquire();
    let released = false;
    return {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values?: unknown[],
      ): Promise<TeamChatQueryResult<Row>> => toQueryResult(await this.database.query<Row>(text, values)),
      release: () => {
        if (released) return;
        released = true;
        releaseLock();
      },
    };
  }

  async end(): Promise<void> {
    const release = await this.acquire();
    try {
      if (!this.database.closed) await this.database.close();
    } finally {
      release();
    }
  }

  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.queue;
    this.queue = previous.then(() => current);
    await previous;
    return release;
  }
}

export class PGliteTeamChatStore extends PostgresTeamChatStore {
  constructor(dataDirectory: string) {
    const database = new PGlite(dataDirectory) as unknown as PGliteQueryLike;
    super("", {
      pool: new SerializedPGlitePool(database),
      migrationLock: false,
    });
  }
}

function toQueryResult<Row extends Record<string, unknown>>(
  result: { rows: Row[]; affectedRows?: number },
): TeamChatQueryResult<Row> {
  return {
    rows: result.rows,
    rowCount: result.affectedRows ?? result.rows.length,
  };
}
