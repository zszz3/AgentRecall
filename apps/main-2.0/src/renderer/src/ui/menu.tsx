import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  key: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * A button that opens a list of actions. The list is portaled to `document.body` so scrolling
 * or clipping containers (virtualized lists, sheets) never cut it off; because a portaled list
 * would otherwise float over a moved anchor, scrolling anywhere or resizing closes it.
 */
export function MenuButton({ label, icon, text, items, disabled = false, className = "" }: {
  label: string;
  icon?: ReactNode;
  text?: ReactNode;
  items: readonly MenuItem[];
  disabled?: boolean;
  className?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!open || !menu || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    const below = rect.bottom + 4;
    const top = below + height <= window.innerHeight - 8 ? below : rect.top - height - 4;
    menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent | FocusEvent): void => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    const closeOnLayoutChange = (): void => setOpen(false);
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", closeOnLayoutChange, true);
    window.addEventListener("resize", closeOnLayoutChange);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", closeOnLayoutChange, true);
      window.removeEventListener("resize", closeOnLayoutChange);
    };
  }, [open]);

  const navigate = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
        : event.key === "ArrowDown" ? (index + 1) % buttons.length
          : event.key === "ArrowUp" ? (index + buttons.length - 1) % buttons.length
            : null;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ui-menu-trigger ${className} ${open ? "active" : ""}`}
        aria-label={text ? undefined : label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {icon}{text}
      </button>
      {open ? createPortal(
        <div ref={menuRef} className="ui-menu" role="menu" aria-label={label} onKeyDown={navigate}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.hint ? <small>{item.hint}</small> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
