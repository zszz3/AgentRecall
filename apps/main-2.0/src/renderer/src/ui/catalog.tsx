import type { ReactNode } from "react";
import { Search } from "lucide-react";

/**
 * A resource page that finds things rather than edits them: a one-line header (title, count,
 * search, actions) over a full-width list and the selected item's detail. The marker classes
 * (catalog-head, catalog-item, …) name the parts for pages and tests; the look is in the utilities.
 */
export function CatalogPage({ title, meta, search, actions, children }: {
  title: string;
  meta?: ReactNode;
  search?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return <section className="catalog-page flex h-full min-h-0 flex-col bg-background">
    <header className="app-page-head catalog-head flex items-center gap-3 px-6 py-3">
      <div className="catalog-head-title flex w-auto min-w-0 flex-[0_1_auto] items-baseline gap-2.5">
        <h2 className="m-0 text-base leading-6 font-semibold tracking-tight whitespace-nowrap text-foreground">{title}</h2>
        {meta ? <span className="catalog-head-meta truncate text-[13px] text-muted-foreground">{meta}</span> : null}
      </div>
      {search}
      {actions ? <div className={`catalog-head-actions flex flex-none items-center gap-1.5 [-webkit-app-region:no-drag] ${search ? "" : "ml-auto"}`}>{actions}</div> : null}
    </header>
    <div className="catalog-body flex min-h-0 flex-1 flex-col">{children}</div>
  </section>;
}

export function CatalogSearch({ value, onChange, label, placeholder }: { value: string; onChange(value: string): void; label: string; placeholder: string }) {
  return <label className="catalog-search ml-auto flex h-8 min-w-[160px] flex-[0_1_280px] items-center gap-2 rounded-lg border-0 bg-muted/65 px-2.5 text-muted-foreground shadow-(--control-shadow) transition-[background-color,color,box-shadow] [-webkit-app-region:no-drag] focus-within:bg-card focus-within:text-foreground focus-within:shadow-(--focus-ring)">
    <Search className="size-3.5 shrink-0" aria-hidden="true" />
    <input
      type="search"
      value={value}
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="h-full min-h-0 min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-0 focus-visible:shadow-none"
    />
  </label>;
}

export function CatalogGroup({ title, hint, count, children }: { title: string; hint?: string; count?: number; children: ReactNode }) {
  return <section className="catalog-group" aria-label={title}>
    <h3 title={hint} className="catalog-group-head">
      <span className="truncate">{title}</span>
      {count === undefined ? null : <small className="catalog-group-count">{count}</small>}
    </h3>
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{children}</ul>
  </section>;
}

export function CatalogItem({ title, meta, icon, trailing, selected, onSelect }: {
  title: string;
  meta?: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  selected: boolean;
  onSelect(): void;
}) {
  return <li>
    <button
      type="button"
      className="catalog-item"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      {icon ? <span className="catalog-item-icon" aria-hidden="true">{icon}</span> : null}
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
  return <article className="catalog-detail px-7 pt-5 pb-10" aria-label={title}>
    <header className="catalog-detail-head flex items-start justify-between gap-4">
      <div className="catalog-detail-title flex min-w-0 flex-col gap-1">
        <h3 className="m-0 text-lg leading-7 font-semibold break-words text-foreground">{title}</h3>
        {subtitle ? <div className="catalog-detail-subtitle text-sm break-all text-muted-foreground [&_code]:font-mono [&_code]:text-xs">{subtitle}</div> : null}
      </div>
      {actions ? <div className="catalog-detail-actions flex flex-none flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </header>
    {facts && facts.length > 0 ? <dl className="catalog-facts m-0 mt-4 flex flex-wrap gap-x-7 gap-y-2.5 rounded-xl bg-card px-4 py-3 shadow-(--card-shadow)">
      {facts.map((fact) => <div key={fact.label} className="flex min-w-0 flex-col gap-0.5">
        <dt className="text-xs text-muted-foreground">{fact.label}</dt>
        <dd className="m-0 text-sm break-words text-foreground">{fact.value}</dd>
      </div>)}
    </dl> : null}
    {children ? <div className="catalog-detail-body mt-5 flex max-w-[940px] flex-col gap-4">{children}</div> : null}
  </article>;
}
