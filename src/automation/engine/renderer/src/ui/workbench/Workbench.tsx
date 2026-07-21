import type { ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";

export interface WorkbenchTab<T extends string> {
  id: T;
  label: string;
  count?: number;
}

export function WorkbenchHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="workbench-header">
      <div className="workbench-heading">
        {eyebrow ? <span className="workbench-eyebrow">{eyebrow}</span> : null}
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action ? <div className="workbench-header-action">{action}</div> : null}
    </header>
  );
}

export function WorkbenchTabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: WorkbenchTab<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <nav className="workbench-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={active === tab.id ? "is-active" : ""}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          {tab.count !== undefined ? <small>{tab.count}</small> : null}
        </button>
      ))}
    </nav>
  );
}

export function WorkbenchLayout({
  browser,
  children,
}: {
  browser: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="workbench-layout">
      <aside className="workbench-browser">{browser}</aside>
      <section className="workbench-detail">{children}</section>
    </div>
  );
}

export function BrowserHeader({
  label,
  actionLabel,
  onAdd,
}: {
  label: string;
  actionLabel: string;
  onAdd: () => void;
}) {
  return (
    <div className="workbench-browser-header">
      <span>{label}</span>
      <button
        type="button"
        className="icon-btn"
        aria-label={actionLabel}
        title={actionLabel}
        onClick={onAdd}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

export function BrowserItem({
  selected,
  title,
  meta,
  status,
  onClick,
}: {
  selected: boolean;
  title: string;
  meta: string;
  status?: "success" | "danger" | "muted";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`workbench-browser-item ${selected ? "is-active" : ""}`}
      onClick={onClick}
    >
      <span className="workbench-browser-item-main">
        <strong>{title}</strong>
        <small>{meta}</small>
      </span>
      {status ? (
        <i className={`workbench-item-status is-${status}`} />
      ) : (
        <ChevronRight size={13} />
      )}
    </button>
  );
}

export function DetailToolbar({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: string;
  actions: ReactNode;
}) {
  return (
    <div className="workbench-detail-toolbar">
      <div>
        <h3>{title}</h3>
        {meta ? <p>{meta}</p> : null}
      </div>
      <div className="workbench-actions">{actions}</div>
    </div>
  );
}

export function WorkbenchSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="workbench-section">
      <div className="workbench-section-heading">
        <div>
          <h4>{title}</h4>
          {description ? <p>{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function WorkbenchEmpty({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="workbench-empty">
      <span className="workbench-empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {actionLabel && onAction ? (
        <button className="control-btn compact secondary" type="button" onClick={onAction}>
          <Plus size={13} />
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function MetricStrip({
  items,
}: {
  items: Array<{
    label: string;
    value: string;
    tone?: "success" | "danger";
    detail?: string;
  }>;
}) {
  return (
    <div className="workbench-metrics">
      {items.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <strong className={item.tone ? `is-${item.tone}` : ""}>
            {item.value}
          </strong>
          {item.detail ? <small>{item.detail}</small> : null}
        </div>
      ))}
    </div>
  );
}

export function InlineStatus({
  tone,
  children,
}: {
  tone: "success" | "danger" | "muted" | "busy";
  children: ReactNode;
}) {
  return (
    <span className={`workbench-inline-status is-${tone}`}>
      <i />
      {children}
    </span>
  );
}
