import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * Shared building blocks of the redesigned renderer. Pages compose these and the
 * tokens in styles/tokens.css instead of styling their own buttons, cards and
 * rows; their look lives in styles/ui.css.
 */

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }): ReactElement {
  return (
    <header className="app-page-head ui-page-head">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="ui-page-actions">{actions}</div> : null}
    </header>
  );
}

/** Scrolling page content with a readable maximum width. */
export function PageBody({ children }: { children: ReactNode }): ReactElement {
  return <div className="ui-page-body"><div className="ui-page-column">{children}</div></div>;
}

export function Section({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <section className="ui-section">
      <header className="ui-section-head">
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="ui-section-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** One rounded surface whose rows are separated by hairlines. */
export function Group({ children }: { children: ReactNode }): ReactElement {
  return <div className="ui-group">{children}</div>;
}

type RowContent = { icon?: ReactNode; title: ReactNode; description?: ReactNode; trailing?: ReactNode };

/**
 * A row of a Group. With `onClick` the whole row is one button named by
 * `label`, so its description does not become part of the accessible name.
 */
export function Row({ icon, title, description, trailing, onClick, label, disabled }: RowContent & { onClick?: () => void; label?: string; disabled?: boolean }): ReactElement {
  const content = <>
    {icon ? <span className="ui-row-icon">{icon}</span> : null}
    <span className="ui-row-text">
      <span className="ui-row-title">{title}</span>
      {description ? <span className="ui-row-description">{description}</span> : null}
    </span>
    {trailing ? <span className="ui-row-trailing">{trailing}</span> : null}
  </>;
  if (!onClick) return <div className="ui-row">{content}</div>;
  return (
    <button type="button" className="ui-row ui-row-button" aria-label={label} disabled={disabled} onClick={onClick}>
      {content}
      <ChevronRight className="ui-row-chevron" size={16} aria-hidden="true" />
    </button>
  );
}

/** A small square holding an initial or icon at the start of a row. */
export function IconTile({ children }: { children: ReactNode }): ReactElement {
  return <span className="ui-icon-tile" aria-hidden="true">{children}</span>;
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: ReactNode;
};

export function Button({ variant = "secondary", size = "md", icon, children, type = "button", ...props }: ButtonProps): ReactElement {
  return (
    <button {...props} type={type} className={`ui-button ui-button-${variant} ui-button-${size}`}>
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, icon, variant = "ghost", size = "md", ...props }: Omit<ButtonProps, "children" | "aria-label"> & { label: string; icon: ReactNode }): ReactElement {
  return (
    <button {...props} type="button" aria-label={label} title={label} className={`ui-button ui-icon-button ui-button-${variant} ui-button-${size}`}>
      {icon}
    </button>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label, disabled }: {
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  value: T;
  onChange(value: T): void;
  label: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <div className="ui-segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count === undefined ? null : <small className="ui-segmented-count">{option.count}</small>}
        </button>
      ))}
    </div>
  );
}

/** A native checkbox drawn as a switch, so forms, labels and keyboard behave as usual. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }): ReactElement {
  return (
    <input
      type="checkbox"
      role="switch"
      className="ui-switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "success" | "warning" | "danger"; children: ReactNode }): ReactElement {
  return <span className={`ui-badge ui-badge-${tone}`}>{children}</span>;
}

/** Result of the last action on a page. Running and successful notices are polite; errors stay until the next action. */
export function Notice({ kind, children }: { kind: "info" | "running" | "success" | "error"; children: ReactNode }): ReactElement {
  return <div role="status" className={`ui-notice ui-notice-${kind}`}>{children}</div>;
}

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }): ReactElement {
  return (
    <div className="ui-empty">
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}
