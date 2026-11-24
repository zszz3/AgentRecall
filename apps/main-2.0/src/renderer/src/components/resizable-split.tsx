import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

interface ResizableSplitProps {
  children: ReactNode[];
  className: string;
  label: string;
  storageKey: string;
  initialWidth: number;
  minWidth?: number;
  maxWidth?: number;
  minContentWidth?: number;
}

export function ResizableSplit({ children, className, label, storageKey, initialWidth,
  minWidth = 180, maxWidth = 400, minContentWidth = 360 }: ResizableSplitProps) {
  const container = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<((fromUnmount?: boolean) => void) | null>(null);
  const dirty = useRef(false);
  const dragging = useRef(false);
  const latestWidth = useRef(0);
  const committedWidth = useRef(0);
  const [available, setAvailable] = useState<number | null>(null);
  const [preferred, setPreferred] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= minWidth && saved <= maxWidth) return saved;
    } catch { /* Resizing remains usable when local storage is unavailable. */ }
    return initialWidth;
  });
  const stacked = available !== null && available < minWidth + minContentWidth + 8;
  const limit = Math.max(minWidth, Math.min(maxWidth, (available ?? maxWidth + minContentWidth + 8) - minContentWidth - 8));
  const width = Math.max(minWidth, Math.min(preferred, limit));
  latestWidth.current = preferred;
  committedWidth.current = preferred;

  const persistWidth = (value: number) => {
    try { localStorage.setItem(storageKey, String(value)); }
    catch { /* Width persistence is optional, never a requirement for interaction. */ }
  };

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const w = element.clientWidth;
      // Ignore 0px measurements while a keep-alive parent tab is hidden via display: none.
      if (w > 0) setAvailable(w);
    };
    measure();
    // ResizeObserver runs during layout delivery. Publish on the next frame so
    // changing the grid cannot synchronously trigger another observer delivery.
    const observer = new ResizeObserver(() => {
      if (frame === null) frame = window.requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      stopDrag.current?.(true);
    };
  }, []);
  // Persist only after an explicit user resize (keyboard/double-click immediately; pointer drag on release).
  useEffect(() => {
    if (!dirty.current || dragging.current) return;
    persistWidth(preferred);
  }, [preferred, storageKey]);

  const update = (next: number) => {
    const clamped = Math.max(minWidth, Math.min(next, limit));
    dirty.current = true;
    latestWidth.current = clamped;
    setPreferred(clamped);
  };
  const style: CSSProperties = {
    gridTemplateColumns: stacked ? "minmax(0, 1fr)" : `${width}px 8px minmax(0, 1fr)`,
    gridTemplateRows: stacked ? "minmax(100px, 180px) minmax(360px, 1fr)" : "minmax(0, 1fr)",
  };
  return <div ref={container} className={`resizable-split ${className}`} style={style} data-stacked={stacked}>
    {children[0]}
    <div className="pane-resize-handle" role="separator" aria-label={label} aria-orientation="vertical"
      aria-valuemin={minWidth} aria-valuemax={limit} aria-valuenow={Math.round(width)} tabIndex={stacked ? -1 : 0}
      onDoubleClick={() => update(initialWidth)}
      onKeyDown={event => {
        const next = event.key === "Home" ? minWidth : event.key === "End" ? limit
          : event.key === "ArrowLeft" ? width - 16 : event.key === "ArrowRight" ? width + 16 : null;
        if (next !== null) { event.preventDefault(); update(next); }
      }}
      onPointerDown={event => {
        if (event.button !== 0 || stacked) return;
        event.preventDefault();
        event.currentTarget.focus();
        stopDrag.current?.();
        const start = event.clientX;
        const cursor = document.body.style.cursor;
        const selection = document.body.style.userSelect;
        dragging.current = true;
        const move = (pointer: PointerEvent) => update(width + pointer.clientX - start);
        const stop = (fromUnmount = false) => {
          dragging.current = false;
          if (dirty.current) persistWidth(fromUnmount ? committedWidth.current : latestWidth.current);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", onEnd);
          window.removeEventListener("pointercancel", onEnd);
          window.removeEventListener("blur", onEnd);
          document.body.style.cursor = cursor;
          document.body.style.userSelect = selection;
          stopDrag.current = null;
        };
        const onEnd = () => stop(false);
        stopDrag.current = stop;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", onEnd);
        window.addEventListener("pointercancel", onEnd);
        window.addEventListener("blur", onEnd);
      }} />
    {children.slice(1)}
  </div>;
}
