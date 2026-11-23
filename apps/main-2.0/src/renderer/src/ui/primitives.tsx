import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";

/**
 * Shared building blocks of the redesigned renderer. Pages compose these and the
 * tokens in styles/tokens.css instead of styling their own buttons and badges;
 * their look lives in styles/ui.css. Page layout lives in ui/catalog.tsx.
 */

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
