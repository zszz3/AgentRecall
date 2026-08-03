import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { DEFAULT_SNAPSHOT } from "../../../../automation/engine/renderer/src/app/app-state";
import type { AppSnapshot } from "../../../../automation/contracts";
import type { AutomationApi } from "../../../../preload/automation";
import type { AutomationHealth, WorkflowSidebarSnapshot } from "../../../../shared/ipc/automation";
import { AutomationStore } from "./automation-store";

interface AutomationContextValue {
  api: AutomationApi;
  snapshot: AppSnapshot;
  setSnapshot: Dispatch<SetStateAction<AppSnapshot>>;
  health: AutomationHealth;
  workflowSidebar: WorkflowSidebarSnapshot;
  workflowSidebarLoading: boolean;
  detailsLoaded: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<AppSnapshot>;
  store: AutomationStore;
}

const AutomationContext = createContext<AutomationContextValue | null>(null);

export function AutomationProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => window.sessionSearch.automation, []);
  const storeRef = useRef<AutomationStore | undefined>(undefined);
  if (!storeRef.current) storeRef.current = new AutomationStore(DEFAULT_SNAPSHOT);
  const store = storeRef.current;
  const [snapshot, setSnapshotState] = useState<AppSnapshot>(DEFAULT_SNAPSHOT);
  const snapshotRef = useRef(snapshot);
  const resyncInFlightRef = useRef<Promise<AppSnapshot> | undefined>(undefined);
  const setSnapshot = useCallback<Dispatch<SetStateAction<AppSnapshot>>>((value) => {
    const next = typeof value === "function" ? value(snapshotRef.current) : value;
    snapshotRef.current = next;
    store.replace(next);
    setSnapshotState(next);
  }, [store]);
  const [health, setHealth] = useState<AutomationHealth>({ state: "initializing" });
  const [workflowSidebar, setWorkflowSidebar] = useState<WorkflowSidebarSnapshot>({ workflows: [] });
  const [workflowSidebarLoading, setWorkflowSidebarLoading] = useState(true);
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const detailsLoadedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<AppSnapshot> => {
    if (!detailsLoadedRef.current) setLoading(true);
    try {
      const next = await api.getSnapshot();
      setSnapshot(next);
      detailsLoadedRef.current = true;
      setDetailsLoaded(true);
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
  }, [api, setSnapshot]);

  useEffect(() => {
    let active = true;
    const unsubscribe = api.onSnapshot((next) => {
      if (!active) return;
      setSnapshot(next);
      detailsLoadedRef.current = true;
      setDetailsLoaded(true);
      setHealth({ state: "ready" });
      setError(null);
      setLoading(false);
    });
    const unsubscribeChanges = api.onChange((change) => {
      if (!active) return;
      if (store.applyChange(change)) {
        return;
      }
      resyncInFlightRef.current ??= refresh()
        .catch(() => snapshotRef.current)
        .finally(() => {
          resyncInFlightRef.current = undefined;
        });
    });
    void api.getHealth().then((next) => {
      if (active) setHealth(next);
    }).catch(() => undefined);
    void (async () => {
      try {
        const next = await api.getWorkflowSidebar();
        if (active) setWorkflowSidebar(next);
      } catch {
        // The full snapshot remains the fallback when the lightweight query fails.
      } finally {
        if (active) {
          setWorkflowSidebarLoading(false);
          void refresh().catch(() => undefined);
        }
      }
    })();
    return () => {
      active = false;
      unsubscribe();
      unsubscribeChanges();
    };
  }, [api, refresh, setSnapshot, store]);

  const value = useMemo<AutomationContextValue>(() => ({
    api,
    snapshot,
    setSnapshot,
    health,
    workflowSidebar,
    workflowSidebarLoading,
    detailsLoaded,
    loading,
    error,
    refresh,
    store,
  }), [api, detailsLoaded, error, health, loading, refresh, snapshot, store, setSnapshot, workflowSidebar, workflowSidebarLoading]);

  return <AutomationContext.Provider value={value}>{children}</AutomationContext.Provider>;
}

export function useAutomationStoreSnapshot(): AppSnapshot {
  const { store } = useAutomation();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useAutomation(): AutomationContextValue {
  const value = useContext(AutomationContext);
  if (!value) throw new Error("useAutomation must be used inside AutomationProvider.");
  return value;
}
