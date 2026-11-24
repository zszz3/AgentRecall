import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

export interface MenuItem {
  key: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Marks the current choice of a single-choice list; the item becomes a radio item. */
  checked?: boolean;
  /** Heading shown above the first item of each run of items with the same section. */
  section?: string;
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
    const spaceBelow = Math.max(120, window.innerHeight - rect.bottom - 12);
    const spaceAbove = Math.max(120, rect.top - 12);
    const openBelow = spaceBelow >= 180 || spaceBelow >= spaceAbove;
    const maxHeight = Math.min(380, openBelow ? spaceBelow : spaceAbove);
    menu.style.maxHeight = `${Math.floor(maxHeight)}px`;

    const { width, height } = menu.getBoundingClientRect();
    // Anchor left edge to the trigger (falling back to right alignment near the window's right edge)
    // so left-hand filter chips like "Project" never drift over the sidebar or macOS traffic lights.
    const preferredLeft = rect.left + width <= window.innerWidth - 8
      ? rect.left
      : rect.right - width;
    menu.style.left = `${Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8))}px`;
    const top = openBelow ? rect.bottom + 4 : rect.top - height - 4;
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
    const closeOnLayoutChange = (event: Event): void => {
      if (event.type === "scroll" && menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
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
          {items.map((item, index) => (
            <Fragment key={item.key}>
              {item.section && item.section !== items[index - 1]?.section
                ? <div className="ui-menu-section" role="presentation">{item.section}</div>
                : null}
              <button
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
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
                {item.checked ? <Check className="ui-menu-check" size={14} aria-hidden="true" /> : null}
              </button>
            </Fragment>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
