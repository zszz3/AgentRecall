import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test } from 'vitest';
import { PostgresDatabase, type PostgresClient, type PostgresPool } from '../../src/core/postgres/database';
import { PGliteTestPool } from '../../src/core/postgres/test-pglite';
import { POSTGRES_MIGRATIONS } from '../../src/core/postgres/schema';
import { SessionStore } from '../../src/core/session-store';
import { syncDefaultSessionsInBatches } from '../../src/core/indexer';

test('measures append indexing against increasing history without real user data', async () => {
  const results: unknown[] = [];
  for (const turns of [100, 1000, 10000]) {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-index-experiment-'));
    const pool = new PGliteTestPool();
    let measured = false, returnedRows = 0, calls = 0, sqlBytes = 0;
    const query = <T extends Record<string, unknown>>(target: Pick<PostgresClient, 'query'>, sql: string, values?: readonly unknown[]) =>
      target.query<T>(sql, values).then(result => {
        if (measured) { returnedRows += result.rows.length; calls++; sqlBytes += Buffer.byteLength(JSON.stringify(values ?? [])); }
        return result;
      });
    const measuredPool: PostgresPool = {
      query: (sql, values) => query(pool, sql, values),
      connect: async () => { const client = await pool.connect(); return { query: (sql, values) => query(client, sql, values), release: () => client.release() }; },
      end: () => pool.end(),
    };
    const database = new PostgresDatabase(measuredPool, { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    const store = new SessionStore(database, database.initialize());
    try {
      const dir = path.join(homeDir, '.codex', 'sessions'); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout-bench.jsonl');
      const message = (index: number, role: string) => JSON.stringify({ type: 'response_item', timestamp: new Date(1780308000000 + index * 1000).toISOString(), payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: `${role} ${index}` }] } });
      const lines = [JSON.stringify({ type: 'session_meta', timestamp: '2026-06-01T10:00:00Z', payload: { id: 'bench', cwd: '/synthetic' } })];
      for (let i = 0; i < turns; i++) lines.push(message(i * 2, 'user'), message(i * 2 + 1, 'assistant'));
      fs.writeFileSync(file, lines.join('\n') + '\n');
      expect((await syncDefaultSessionsInBatches(store, { loadOptions: { homeDir } })).error).toBeNull();
      fs.appendFileSync(file, message(turns * 2, 'assistant') + '\n');
      measured = true;
      const start = performance.now();
      const status = await syncDefaultSessionsInBatches(store, { loadOptions: { homeDir } });
      const elapsedMs = performance.now() - start;
      measured = false;
      expect(status.error).toBeNull(); expect(status.indexed).toBe(1);
      expect(returnedRows).toBeLessThan(30);
      expect(sqlBytes).toBeLessThan(10000);
      expect((await store.getAllMessages('codex:bench')).length).toBe(turns * 2 + 1);
      results.push({ turns, elapsedMs: Math.round(elapsedMs), returnedRows, calls, sqlBytes });
    } finally { await store.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
  }
  console.log('JSONL_APPEND_EXPERIMENT', JSON.stringify(results));
}, 180000);
