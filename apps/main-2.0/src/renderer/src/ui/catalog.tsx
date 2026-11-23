import type { ReactNode } from "react";
import { Search } from "lucide-react";

/**
 * A resource page that finds things rather than edits them: a one-line header (title, count,
 * search, actions) over a full-width list and the selected item's detail.
 */
export function CatalogPage({ title, meta, search, actions, children }: {
  title: string;
  meta?: ReactNode;
  search?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return <section className="catalog-page">
    <header className="app-page-head catalog-head">
      <div className="catalog-head-title">
        <h2>{title}</h2>
        {meta ? <span className="catalog-head-meta">{meta}</span> : null}
      </div>
      {search}
      {actions ? <div className="catalog-head-actions">{actions}</div> : null}
    </header>
    <div className="catalog-body">{children}</div>
  </section>;
}

export function CatalogSearch({ value, onChange, label, placeholder }: { value: string; onChange(value: string): void; label: string; placeholder: string }) {
  return <label className="catalog-search">
    <Search size={14} aria-hidden="true" />
    <input type="search" value={value} aria-label={label} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
  </label>;
}

export function CatalogGroup({ title, hint, count, children }: { title: string; hint?: string; count?: number; children: ReactNode }) {
  return <section className="catalog-group" aria-label={title}>
    <h3 title={hint}>
      <span>{title}</span>
      {count === undefined ? null : <small>{count}</small>}
    </h3>
    <ul>{children}</ul>
  </section>;
}

export function CatalogItem({ title, meta, trailing, selected, onSelect }: { title: string; meta?: ReactNode; trailing?: ReactNode; selected: boolean; onSelect(): void }) {
  return <li>
    <button type="button" className="catalog-item" aria-current={selected ? "true" : undefined} onClick={onSelect}>
      <span className="catalog-item-text">
        <span className="catalog-item-title">{title}</span>
        {meta ? <span className="catalog-item-meta">{meta}</span> : null}
      </span>
      {trailing ? <span className="catalog-item-trailing">{trailing}</span> : null}
    </button>
  </li>;
}

export function CatalogDetail({ title, subtitle, facts, actions, children }: {
  title: string;
  subtitle?: ReactNode;
  /** Short label–value pairs shown under the title. */
  facts?: Array<{ label: string; value: ReactNode }>;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return <article className="catalog-detail" aria-label={title}>
    <header className="catalog-detail-head">
      <div className="catalog-detail-title">
        <h3>{title}</h3>
        {subtitle ? <div className="catalog-detail-subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div className="catalog-detail-actions">{actions}</div> : null}
    </header>
    {facts && facts.length > 0 ? <dl className="catalog-facts">
      {facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
    </dl> : null}
    {children ? <div className="catalog-detail-body">{children}</div> : null}
  </article>;
}
