export interface UpstreamSessionReader<Summary, Detail> {
  list(): Promise<readonly Summary[]> | readonly Summary[];
  read(sessionKey: string): Promise<Detail | null> | Detail | null;
}

export interface ReadOnlyUpstreamSessionApi<Summary, Detail> {
  readonly operations: readonly ["list", "read"];
  list(): Promise<readonly Readonly<Summary>[]>;
  read(sessionKey: string): Promise<Readonly<Detail> | null>;
}

function immutableClone<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const seen = new WeakSet<object>();

  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const nested of Object.values(candidate)) freeze(nested);
    Object.freeze(candidate);
  };

  freeze(clone);
  return clone;
}

/**
 * Narrows any session loader to the only two operations that may touch an
 * upstream Claude/Codex session: enumerate and read. The returned values are
 * detached and frozen so consumers cannot mutate a loader-owned cache.
 */
export function createReadOnlyUpstreamSessionApi<Summary, Detail>(
  reader: UpstreamSessionReader<Summary, Detail>,
): ReadOnlyUpstreamSessionApi<Summary, Detail> {
  return Object.freeze({
    operations: Object.freeze(["list", "read"] as const),
    async list() {
      const sessions = await reader.list();
      return Object.freeze(sessions.map((session) => immutableClone(session)));
    },
    async read(sessionKey: string) {
      const session = await reader.read(sessionKey);
      return session === null ? null : immutableClone(session);
    },
  });
}
