export interface AggregateSyncDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

export function replaceAggregateSet<T>(input: {
  db: AggregateSyncDatabase;
  table: string;
  idColumn: string;
  aggregates: readonly T[];
  idOf: (aggregate: T) => string;
  idFromRow: (row: unknown) => string;
  write: (aggregates: readonly T[]) => void;
}): void {
  const nextIds = new Set(input.aggregates.map(input.idOf));
  for (const row of input.db.prepare(`select ${input.idColumn} from ${input.table}`).all()) {
    const id = input.idFromRow(row);
    if (!nextIds.has(id)) input.db.prepare(`delete from ${input.table} where ${input.idColumn} = ?`).run(id);
  }
  for (const aggregate of input.aggregates) {
    input.db.prepare(`delete from ${input.table} where ${input.idColumn} = ?`).run(input.idOf(aggregate));
  }
  if (input.aggregates.length > 0) input.write(input.aggregates);
}
