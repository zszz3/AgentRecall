import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { IndexStatus } from "../../../../core/indexer";
import type { SessionEnvironment, SessionSearchResult } from "../../../../core/types";
import type { RefreshFeedback } from "../../app-types";
import type { AppPage } from "../../components/app-navigation";
import { coalesceIndexStatusForRender } from "../../index-status";
import { reduceIndexFeedback } from "../../index-status-feedback";
import type { SettingsSection } from "../settings/settings-dialog";

export interface AppIpcSubscriptionsOptions {
  activePage: AppPage;
  searchRef: RefObject<HTMLInputElement | null>;
  load: () => Promise<void>;
  loadSidebarMetadata: () => Promise<void>;
  loadStats: (force?: boolean) => Promise<void>;
  loadWorkbenchSessions: () => Promise<void>;
  navigateToPage: (page: AppPage) => Promise<boolean>;
  openDetail: (session: SessionSearchResult) => Promise<void>;
  refreshDetail: () => Promise<void>;
  reportSessionDetailError: (error: unknown) => void;
  setSelectedKey: (sessionKey: string) => void;
  setRefreshFeedback: Dispatch<SetStateAction<RefreshFeedback>>;
  setTeamUploadKeys: Dispatch<SetStateAction<string[] | null>>;
  setSettingsInitialSection: (section: SettingsSection) => void;
  setSettingsOpen: (open: boolean) => void;
  setEnvironments: Dispatch<SetStateAction<SessionEnvironment[]>>;
}

export function useAppIpcSubscriptions(options: AppIpcSubscriptionsOptions) {
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [sessionFamilyRefreshVersion, setSessionFamilyRefreshVersion] = useState(0);
  const indexStatusEventVersionRef = useRef(0);
  const handlersRef = useRef(options);
  handlersRef.current = options;

  useEffect(() => {
    let active = true;
    const snapshotEventVersion = indexStatusEventVersionRef.current;
    const applyIndexStatus = (nextStatus: IndexStatus): void => {
      setIndexStatus((current) => coalesceIndexStatusForRender(current, nextStatus));
      handlersRef.current.setRefreshFeedback((current) =>
        reduceIndexFeedback(current, { type: "index-status", status: nextStatus }),
      );
    };

    const offIndex = window.sessionSearch.onIndexStatus((nextStatus) => {
      indexStatusEventVersionRef.current += 1;
      applyIndexStatus(nextStatus);
      if (!nextStatus.running) {
        const current = handlersRef.current;
        setSessionFamilyRefreshVersion((value) => value + 1);
        if (current.activePage === "sessions") void current.load();
        if (nextStatus.indexed > 0) void current.refreshDetail();
        void current.loadSidebarMetadata();
        void current.loadStats(true);
        void current.loadWorkbenchSessions();
      }
    });
    void window.sessionSearch.getIndexStatus()
      .then((nextStatus) => {
        if (active && indexStatusEventVersionRef.current === snapshotEventVersion) applyIndexStatus(nextStatus);
      })
      .catch(() => undefined);

    const offFocus = window.sessionSearch.onFocusSearch(() => {
      const current = handlersRef.current;
      void current.navigateToPage("sessions").then((navigated) => {
        if (navigated) window.requestAnimationFrame(() => current.searchRef.current?.focus());
      });
    });

    const offOpenSession = window.sessionSearch.onOpenSession((sessionKey) => {
      const current = handlersRef.current;
      void (async () => {
        if (!(await current.navigateToPage("sessions"))) return;
        current.setSelectedKey(sessionKey);
        const session = await window.sessionSearch.getSession(sessionKey);
        if (session) await current.openDetail(session);
      })().catch(current.reportSessionDetailError);
    });

    const offShareToTeam = window.sessionSearch.onShareSessionToTeam?.((sessionKey) => {
      const current = handlersRef.current;
      void (async () => {
        if (!(await current.navigateToPage("sessions"))) return;
        current.setSelectedKey(sessionKey);
        current.setTeamUploadKeys([sessionKey]);
      })().catch(current.reportSessionDetailError);
    }) ?? (() => undefined);

    const offOpenSettings = window.sessionSearch.onOpenSettings(() => {
      handlersRef.current.setSettingsInitialSection("terminal");
      handlersRef.current.setSettingsOpen(true);
    });

    const offEnvironments = window.sessionSearch.onEnvironmentsUpdated((nextEnvironments) => {
      const current = handlersRef.current;
      void current.refreshDetail();
      setSessionFamilyRefreshVersion((value) => value + 1);
      current.setEnvironments(nextEnvironments);
      if (current.activePage === "sessions") void current.load();
    });

    return () => {
      active = false;
      offIndex();
      offFocus();
      offOpenSession();
      offShareToTeam();
      offOpenSettings();
      offEnvironments();
    };
  }, []);

  return { indexStatus, setIndexStatus, sessionFamilyRefreshVersion };
}
