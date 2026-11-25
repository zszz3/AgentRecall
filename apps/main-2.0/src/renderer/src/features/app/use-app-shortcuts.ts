import { useCallback, useEffect, type RefObject } from "react";
import type { SessionSearchResult } from "../../../../core/types";
import type { ActionStatus } from "../../app-types";
import type { AppPage } from "../../components/app-navigation";
import { supportsResumeSource } from "../../session-ui";
import { useMainSearchShortcut } from "../search/use-main-search-shortcut";

export interface AppShortcutsOptions {
  platform: NodeJS.Platform;
  searchRef: RefObject<HTMLInputElement | null>;
  navigateToPage: (page: AppPage) => Promise<boolean>;
  displayedResults: SessionSearchResult[];
  selectedKey: string | null;
  setSelectedKey: (sessionKey: string) => void;
  actionStatus: ActionStatus | null;
  anyOverlayOpen: boolean;
  modalOverlayOpen: boolean;
  onOpenSettingsShortcut: () => void;
  onEscapeOverlay: () => boolean;
  onResumeSession: (session: SessionSearchResult) => void;
  onOpenSession: (session: SessionSearchResult) => void;
}

export function useAppShortcuts(options: AppShortcutsOptions): void {
  const {
    platform,
    searchRef,
    navigateToPage,
    displayedResults,
    selectedKey,
    setSelectedKey,
    actionStatus,
    anyOverlayOpen,
    modalOverlayOpen,
    onOpenSettingsShortcut,
    onEscapeOverlay,
    onResumeSession,
    onOpenSession,
  } = options;

  const focusMainSearch = useCallback(() => {
    void navigateToPage("sessions").then((navigated) => {
      if (!navigated) return;
      window.requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    });
  }, [navigateToPage, searchRef]);

  useMainSearchShortcut(!anyOverlayOpen, focusMainSearch);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        onOpenSettingsShortcut();
        return;
      }

      if (event.key === "Escape") {
        if (onEscapeOverlay()) {
          event.preventDefault();
        }
        return;
      }

      // Leave list navigation alone while an overlay or menu is in front.
      if (anyOverlayOpen) return;

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (actionStatus?.kind === "running" || !selectedKey) return;
        const session = displayedResults.find((item) => item.sessionKey === selectedKey);
        if (session && supportsResumeSource(session.source)) {
          onResumeSession(session);
        }
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (displayedResults.length === 0) return;
        event.preventDefault();
        const currentIndex = displayedResults.findIndex((session) => session.sessionKey === selectedKey);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          currentIndex < 0
            ? platform === "darwin" && delta === -1
              ? displayedResults.length - 1
              : 0
            : Math.min(displayedResults.length - 1, Math.max(0, currentIndex + delta));
        setSelectedKey(displayedResults[nextIndex].sessionKey);
        return;
      }

      if (event.key === " " && selectedKey) {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        const session = displayedResults.find((item) => item.sessionKey === selectedKey);
        if (session) {
          event.preventDefault();
          onOpenSession(session);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    platform,
    displayedResults,
    selectedKey,
    setSelectedKey,
    actionStatus,
    anyOverlayOpen,
    onOpenSettingsShortcut,
    onEscapeOverlay,
    onResumeSession,
    onOpenSession,
  ]);

  useEffect(() => {
    if (!selectedKey) return;
    document.querySelector(".session-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    document.body.classList.toggle("overlay-open", modalOverlayOpen);
    return () => document.body.classList.remove("overlay-open");
  }, [modalOverlayOpen]);
}
