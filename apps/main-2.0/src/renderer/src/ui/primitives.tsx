import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { Badge as BadgeBase } from "../components/ui/badge";
import { Button as ButtonBase, buttonVariants } from "../components/ui/button";
import { Switch as SwitchBase } from "../components/ui/switch";
import { cn } from "../lib/utils";

/**
 * Shared building blocks of the renderer, drawn with the shadcn/ui components in
 * components/ui/. Pages compose these instead of styling their own buttons and
 * badges. Page layout lives in ui/catalog.tsx.
 */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const VARIANTS = { primary: "default", secondary: "outline", ghost: "ghost", danger: "destructive" } as const;

function baseSize(size: ButtonSize, icon: boolean) {
  return icon ? (size === "sm" ? "icon-xs" : "icon-sm") : size === "sm" ? "xs" : "sm";
}

/** Classes of a Button, for elements that render their own button (such as a menu trigger). */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", icon = false): string {
  return buttonVariants({ variant: VARIANTS[variant], size: baseSize(size, icon) });
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
};

export function Button({ variant = "secondary", size = "md", icon, children, type = "button", ...props }: ButtonProps): ReactElement {
  return (
    <ButtonBase {...props} type={type} variant={VARIANTS[variant]} size={baseSize(size, false)}>
      {icon}
      {children}
    </ButtonBase>
  );
}

export function IconButton({ label, icon, variant = "ghost", size = "md", ...props }: Omit<ButtonProps, "children" | "aria-label"> & { label: string; icon: ReactNode }): ReactElement {
  return (
    <ButtonBase {...props} type="button" aria-label={label} title={label} variant={VARIANTS[variant]} size={baseSize(size, true)} className={variant === "ghost" ? "text-muted-foreground hover:text-foreground" : undefined}>
      {icon}
    </ButtonBase>
  );
}

/** A row of exclusive choices drawn like shadcn's tabs list. */
export function Segmented<T extends string>({ options, value, onChange, label, disabled }: {
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  value: T;
  onChange(value: T): void;
  label: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <div className="inline-flex h-8 w-fit items-center rounded-lg bg-muted p-[3px] text-muted-foreground" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className="inline-flex h-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-2.5 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm dark:aria-selected:border-input dark:aria-selected:bg-input/30"
        >
          {option.label}
          {option.count === undefined ? null : <small data-slot="segmented-count" className="text-xs font-normal text-muted-foreground tabular-nums">{option.count}</small>}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }): ReactElement {
  return <SwitchBase aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />;
}

const BADGE_TONES = {
  neutral: "bg-secondary text-secondary-foreground",
  accent: "bg-primary/12 text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-warning/14 text-warning",
  danger: "bg-destructive/10 text-destructive",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }): ReactElement {
  return <BadgeBase className={BADGE_TONES[tone]}>{children}</BadgeBase>;
}

const NOTICE_KINDS = {
  info: "border-border bg-muted text-foreground",
  running: "border-border bg-muted text-muted-foreground",
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  error: "border-destructive/25 bg-destructive/10 text-destructive",
} as const;

/**
 * Result of the last action on a page. Errors and warnings are announced as alerts and stay
 * until the next action; running and successful notices are polite.
 */
export function Notice({ kind, className, children }: { kind: keyof typeof NOTICE_KINDS; className?: string; children: ReactNode }): ReactElement {
  return (
    <div role={kind === "error" || kind === "warning" ? "alert" : "status"} data-slot="notice" data-kind={kind} className={cn("rounded-md border px-3 py-2 text-sm", NOTICE_KINDS[kind], className)}>
      {children}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }): ReactElement {
  return (
    <div data-slot="empty" className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <strong className="text-base font-medium text-foreground">{title}</strong>
      {description ? <p className="m-0 max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}
