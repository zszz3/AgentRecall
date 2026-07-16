export const TOOL_EVENTS_VISIBILITY_STORAGE_KEY = "agent-recall-tool-events-visible";

export interface ToolEventsVisibilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readStoredToolEventsVisibility(value: string | null): boolean {
  return value === "true";
}

function browserStorage(): ToolEventsVisibilityStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readInitialToolEventsVisibility(
  storage: ToolEventsVisibilityStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return readStoredToolEventsVisibility(storage.getItem(TOOL_EVENTS_VISIBILITY_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function storeToolEventsVisibility(
  visible: boolean,
  storage: ToolEventsVisibilityStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(TOOL_EVENTS_VISIBILITY_STORAGE_KEY, String(visible));
  } catch {
    // Persistence is best-effort; keep the current in-memory selection usable.
  }
}
