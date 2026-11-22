import { useCallback, useRef, useState } from "react";
import type { AppPage } from "../../components/app-navigation";
import type { ProviderView } from "../providers/provider-page";

/** What another part of the app asks a page to show once it opens. */
export type PageRequest =
  | { page: "evaluation"; skill: string }
  | { page: "evaluation"; runId?: string; caseId?: string; evaluatorId?: string }
  | { page: "runtimes"; channelId?: string; agentId?: string }
  | { page: "skills"; discovery: true }
  | { page: "providers"; view: ProviderView }
  | { page: "instructions"; addition: string };

export interface PageNavigation {
  activePage: AppPage;
  /** The request for the active page until the page consumes it. */
  request: PageRequest | null;
  navigate(page: AppPage): Promise<boolean>;
  open(request: PageRequest): Promise<boolean>;
  consumeRequest(): void;
  /** The active page can refuse to be left, for example to keep an unsaved draft. */
  setGuard(guard: (() => Promise<boolean>) | null): void;
}

export function usePageNavigation(): PageNavigation {
  const [location, setLocation] = useState<{ page: AppPage; request: PageRequest | null }>({ page: "workbench", request: null });
  const guardRef = useRef<(() => Promise<boolean>) | null>(null);
  const pageRef = useRef(location.page);
  pageRef.current = location.page;

  const go = useCallback(async (page: AppPage, request: PageRequest | null): Promise<boolean> => {
    if (page !== pageRef.current) {
      try {
        if (guardRef.current && !(await guardRef.current())) return false;
      } catch (error) {
        console.warn("Failed to leave the current page", error);
        return false;
      }
      guardRef.current = null;
    }
    // Page and request change in one render, so the page mounts with its request.
    setLocation({ page, request });
    return true;
  }, []);

  const navigate = useCallback((page: AppPage) => go(page, null), [go]);
  const open = useCallback((request: PageRequest) => go(request.page, request), [go]);
  const consumeRequest = useCallback(() => setLocation((current) => (current.request ? { ...current, request: null } : current)), []);
  const setGuard = useCallback((guard: (() => Promise<boolean>) | null) => {
    guardRef.current = guard;
  }, []);

  return { activePage: location.page, request: location.request, navigate, open, consumeRequest, setGuard };
}
