import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentHubPersistedStore } from "./persisted-store";
import type { PersistedAppStateV5 } from "./agent-hub-persistence";

export async function loadPersistedPayload(input: {
  storagePath?: string;
  persistedStore?: AgentHubPersistedStore;
  warn: (message: string, error: unknown) => void;
}): Promise<{
  payload: unknown | undefined;
  persistedStore: AgentHubPersistedStore | undefined;
  shouldBootstrapPersist: boolean;
}> {
  if (input.persistedStore) {
    try {
      const payload = await input.persistedStore.load();
      return {
        payload,
        persistedStore: input.persistedStore,
        shouldBootstrapPersist: payload === undefined,
      };
    } catch (error) {
      input.warn(`Failed to load app state from ${input.persistedStore.label}:`, error);
      return {
        payload: undefined,
        persistedStore: input.persistedStore,
        shouldBootstrapPersist: true,
      };
    }
  }

  if (!input.storagePath) {
    return {
      payload: undefined,
      persistedStore: undefined,
      shouldBootstrapPersist: false,
    };
  }
  try {
    const raw = await readFile(input.storagePath, "utf8");
    return {
      payload: JSON.parse(raw) as unknown,
      persistedStore: undefined,
      shouldBootstrapPersist: false,
    };
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") {
      input.warn(`Failed to load chat history from ${input.storagePath}:`, error);
    }
    return {
      payload: undefined,
      persistedStore: undefined,
      shouldBootstrapPersist: false,
    };
  }
}

export async function writePersistedPayload(input: {
  storagePath?: string;
  persistedStore?: AgentHubPersistedStore;
  payload: PersistedAppStateV5;
}): Promise<void> {
  if (input.persistedStore) {
    await input.persistedStore.save(input.payload);
    return;
  }

  if (!input.storagePath) return;
  const tempPath = `${input.storagePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(input.storagePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(input.payload, null, 2)}\n`, "utf8");
  await rename(tempPath, input.storagePath);
}
