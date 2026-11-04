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
import type { AutomationHealth } from "../../../../shared/ipc/automation";
import { AutomationStore } from "./automation-store";

interface AutomationContextValue {
  api: AutomationApi;
  snapshot: AppSnapshot;
  setSnapshot: Dispatch<SetStateAction<AppSnapshot>>;
  health: AutomationHealth;
  detailsLoaded: boolean;
  loading: boolean;
  error: string | null;
  ensureDetailsLoaded: () => Promise<AppSnapshot>;
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
  const setSnapshot = useCallback<Dispatch<SetStateAction<AppSnapshot>>>((value) => {
    const next = typeof value === "function" ? value(snapshotRef.current) : value;
    snapshotRef.current = next;
    store.replace(next);
    setSnapshotState(next);
  }, [store]);
  const [health, setHealth] = useState<AutomationHealth>({ state: "initializing" });
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const detailsLoadedRef = useRef(false);
  const detailsRequestRef = useRef<Promise<AppSnapshot> | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDetails = useCallback((force: boolean): Promise<AppSnapshot> => {
    if (!force && detailsLoadedRef.current) return Promise.resolve(snapshotRef.current);
    if (detailsRequestRef.current) {
      const currentRequest = detailsRequestRef.current;
      if (!force) return currentRequest;
      return currentRequest.then(
        () => loadDetails(true),
        () => loadDetails(true),
      );
    }
    setLoading(true);
    const request = api.getSnapshot()
      .then((next) => {
        setSnapshot(next);
        detailsLoadedRef.current = true;
        setDetailsLoaded(true);
        setHealth({ state: "ready" });
        setError(null);
        return next;
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setHealth({ state: "error", error: message });
        setError(message);
        throw cause;
      })
      .finally(() => {
        detailsRequestRef.current = undefined;
        setLoading(false);
      });
    detailsRequestRef.current = request;
    return request;
  }, [api, setSnapshot]);

  const ensureDetailsLoaded = useCallback(
    (): Promise<AppSnapshot> => loadDetails(false),
    [loadDetails],
  );
  const refresh = useCallback(
    (): Promise<AppSnapshot> => loadDetails(true),
    [loadDetails],
  );

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
    void api.getHealth().then((next) => {
      if (active) setHealth(next);
    }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, setSnapshot]);

  const value = useMemo<AutomationContextValue>(() => ({
    api,
    snapshot,
    setSnapshot,
    health,
    detailsLoaded,
    loading,
    error,
    ensureDetailsLoaded,
    refresh,
    store,
  }), [api, detailsLoaded, ensureDetailsLoaded, error, health, loading, refresh, snapshot, store, setSnapshot]);

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

export function useAutomationDetails(): AutomationContextValue {
  const value = useAutomation();
  useEffect(() => {
    void value.ensureDetailsLoaded().catch(() => undefined);
  }, [value.ensureDetailsLoaded]);
  return value;
}
