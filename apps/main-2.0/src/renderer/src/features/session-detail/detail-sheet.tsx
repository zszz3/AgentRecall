import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from "react";
import { localize, type LanguageMode } from "../../language";

const DETAIL_WIDTH_STORAGE_KEY = "agentrecall.session-detail-width";
const DEFAULT_DETAIL_WIDTH = 1040;
const MIN_DETAIL_WIDTH = 420;
const MAX_DETAIL_WIDTH = 1200;
const DETAIL_WIDTH_KEYBOARD_STEP = 16;

function detailWidthLimit(): number {
  if (typeof window === "undefined") return MAX_DETAIL_WIDTH;
  return Math.max(MIN_DETAIL_WIDTH, Math.min(MAX_DETAIL_WIDTH, window.innerWidth - 20));
}

function clampDetailWidth(width: number): number {
  return Math.min(Math.max(width, MIN_DETAIL_WIDTH), detailWidthLimit());
}

function readStoredDetailWidth(): number {
  if (typeof window === "undefined") return DEFAULT_DETAIL_WIDTH;
  try {
    const stored = Number(window.localStorage.getItem(DETAIL_WIDTH_STORAGE_KEY));
    return clampDetailWidth(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_DETAIL_WIDTH);
  } catch {
    return DEFAULT_DETAIL_WIDTH;
  }
}

/**
 * Backdrop and resizable side sheet of the session detail view. The sheet owns
 * the persisted width and the pointer/keyboard resize lifecycle, so width
 * changes while dragging re-render only the sheet, not the conversation passed
 * as `children`.
 */
export function DetailSheet({
  backdropClassName,
  language,
  onClose,
  children,
}: {
  backdropClassName: string;
  language: LanguageMode;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  const detailRef = useRef<HTMLElement>(null);
  const resizeRef = useRef<{
    onMove: (event: PointerEvent) => void;
    onStop: () => void;
    previousUserSelect: string;
    previousCursor: string;
  } | null>(null);
  const [detailWidth, setDetailWidth] = useState(readStoredDetailWidth);
  const [resizing, setResizing] = useState(false);

  const stopResizing = () => {
    const activeResize = resizeRef.current;
    if (!activeResize) return;
    document.removeEventListener("pointermove", activeResize.onMove);
    document.removeEventListener("pointerup", activeResize.onStop);
    window.removeEventListener("blur", activeResize.onStop);
    resizeRef.current = null;
    setResizing(false);
    document.body.style.userSelect = activeResize.previousUserSelect;
    document.body.style.cursor = activeResize.previousCursor;
  };

  const startResizing = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const panelRight = detailRef.current?.getBoundingClientRect().right ?? window.innerWidth - 10;
    const onMove = (moveEvent: PointerEvent) => {
      setDetailWidth(clampDetailWidth(panelRight - moveEvent.clientX));
    };
    const onStop = () => stopResizing();
    resizeRef.current = {
      onMove,
      onStop,
      previousUserSelect: document.body.style.userSelect,
      previousCursor: document.body.style.cursor,
    };
    setResizing(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onStop, { once: true });
    window.addEventListener("blur", onStop, { once: true });
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(DETAIL_WIDTH_STORAGE_KEY, String(Math.round(detailWidth)));
    } catch {
      // Width persistence is a convenience; private or unavailable storage should not affect resizing.
    }
  }, [detailWidth]);

  useEffect(() => {
    const handleViewportResize = () => setDetailWidth((current) => clampDetailWidth(current));
    window.addEventListener("resize", handleViewportResize);
    return () => {
      window.removeEventListener("resize", handleViewportResize);
      stopResizing();
    };
  }, []);

  const detailStyle = { "--detail-panel-width": `${detailWidth}px` } as CSSProperties;
  const detailWidthMax = detailWidthLimit();

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setDetailWidth((current) => clampDetailWidth(current + DETAIL_WIDTH_KEYBOARD_STEP));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setDetailWidth((current) => clampDetailWidth(current - DETAIL_WIDTH_KEYBOARD_STEP));
    } else if (event.key === "Home") {
      event.preventDefault();
      setDetailWidth(MIN_DETAIL_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setDetailWidth(detailWidthMax);
    }
  };

  return (
    <div className={`detail-backdrop ${backdropClassName} ${resizing ? "is-resizing" : ""}`.trim()} onClick={onClose}>
      <aside className="detail" ref={detailRef} style={detailStyle} onClick={(event) => event.stopPropagation()}>
        <div
          className="detail-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={localize(language, "Resize conversation details panel", "调整对话详情面板宽度")}
          aria-valuemin={MIN_DETAIL_WIDTH}
          aria-valuemax={detailWidthMax}
          aria-valuenow={Math.round(detailWidth)}
          tabIndex={0}
          onPointerDown={startResizing}
          onKeyDown={handleResizeKeyDown}
        />
        {children}
      </aside>
    </div>
  );
}
