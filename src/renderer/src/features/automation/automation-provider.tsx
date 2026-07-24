import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { DEFAULT_SNAPSHOT } from "../../../../automation/engine/renderer/src/app/app-state";
import type { AppSnapshot } from "../../../../automation/contracts";
import type { AutomationApi } from "../../../../preload/automation";
import type { AutomationHealth } from "../../../../shared/ipc/automation";

interface AutomationContextValue {
  api: AutomationApi;
  snapshot: AppSnapshot;
  setSnapshot: Dispatch<SetStateAction<AppSnapshot>>;
  health: AutomationHealth;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<AppSnapshot>;
}

const AutomationContext = createContext<AutomationContextValue | null>(null);

export function AutomationProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => window.sessionSearch.automation, []);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(DEFAULT_SNAPSHOT);
  const [health, setHealth] = useState<AutomationHealth>({ state: "initializing" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<AppSnapshot> => {
    try {
      const next = await api.getSnapshot();
      setSnapshot(next);
      setHealth({ state: "ready" });
      setError(null);
      return next;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setHealth({ state: "error", error: message });
      setError(message);
      throw cause;
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    const unsubscribe = api.onSnapshot((next) => {
      if (!active) return;
      setSnapshot(next);
      setHealth({ state: "ready" });
      setError(null);
      setLoading(false);
    });
    void api.getHealth().then((next) => {
      if (active) setHealth(next);
    }).catch(() => undefined);
    void refresh().catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, refresh]);

  const value = useMemo<AutomationContextValue>(() => ({
    api,
    snapshot,
    setSnapshot,
    health,
    loading,
    error,
    refresh,
  }), [api, error, health, loading, refresh, snapshot]);

  return <AutomationContext.Provider value={value}>{children}</AutomationContext.Provider>;
}

export function useAutomation(): AutomationContextValue {
  const value = useContext(AutomationContext);
  if (!value) throw new Error("useAutomation must be used inside AutomationProvider.");
  return value;
}
