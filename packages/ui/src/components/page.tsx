/*
 * Page scaffolding shared by every screen: header, cards, key numbers, definition lists, side sheets, and the four
 * data states (loading skeleton, empty with a next step, error with retry, no permission) from PRD §10.1.
 */
import * as React from "react"
import { AlertTriangle, Lock, Maximize2, X } from "lucide-react"

import { cn } from "../lib/utils"

export function PageHeader({
  eyebrow,
  title,
  badge,
  subtitle,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  badge?: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn("flex flex-wrap items-start gap-x-6 gap-y-3", className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="mb-1 text-[13px] text-muted-foreground">{eyebrow}</div>}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="m-0 text-[22px] leading-tight font-semibold tracking-[-0.015em]">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="m-0 mt-1 max-w-3xl text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Breadcrumb({ items }: { items: { label: string; href?: string; onClick?: () => void }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
      {items.map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span aria-hidden>/</span>}
          {it.href || it.onClick ? (
            <a
              href={it.href}
              onClick={(e) => {
                if (it.onClick) {
                  e.preventDefault()
                  it.onClick()
                }
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              {it.label}
            </a>
          ) : (
            <span aria-current="page" className="text-foreground">
              {it.label}
            </span>
          )}
        </React.Fragment>
      ))}
    </nav>
  )
}

export function Card({
  className,
  title,
  action,
  children,
  as: As = "section",
  bodyClassName,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title?: React.ReactNode
  action?: React.ReactNode
  as?: "section" | "div" | "aside"
  bodyClassName?: string
}) {
  return (
    <As className={cn("rounded-[10px] border border-divider bg-surface", className)} {...(props as React.ComponentProps<"div">)}>
      {(title || action) && (
        <div className="flex items-center gap-3 border-b border-divider px-4 py-3">
          {title && <h2 className="m-0 text-[14px] font-semibold">{title}</h2>}
          {action && <div className="ml-auto flex items-center gap-2 text-[13px]">{action}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </As>
  )
}

export function Kpi({
  label,
  value,
  sub,
  goal,
  tone,
  title,
  href,
  onClick,
  children,
}: {
  label: React.ReactNode
  value: React.ReactNode
  sub?: React.ReactNode
  goal?: React.ReactNode
  tone?: "red" | "amber" | "green"
  title?: string
  href?: string
  onClick?: () => void
  children?: React.ReactNode
}) {
  const inner = (
    <>
      <div className="text-[12.5px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "tabular mt-1 text-[26px] leading-none font-semibold tracking-[-0.02em]",
          tone === "red" && "text-st-red",
          tone === "amber" && "text-st-amber",
          tone === "green" && "text-st-green",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1.5 text-[12.5px] text-muted-foreground">{sub}</div>}
      {children}
      {goal && <div className="mt-1 text-xs text-subtle">{goal}</div>}
    </>
  )
  const cls = "block rounded-[10px] border border-divider bg-surface p-4 text-left text-foreground no-underline"
  if (href || onClick)
    return (
      <a
        href={href}
        title={title}
        onClick={(e) => {
          if (onClick) {
            e.preventDefault()
            onClick()
          }
        }}
        className={cn(cls, "hover:border-border hover:bg-hover/40")}
      >
        {inner}
      </a>
    )
  return (
    <div className={cls} title={title}>
      {inner}
    </div>
  )
}

export function Dl({ items, className }: { items: { label: React.ReactNode; value: React.ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("m-0 grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-[13.5px]", className)}>
      {items.map((it, i) => (
        <React.Fragment key={i}>
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className="m-0">{it.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

export function SideSheet({
  label,
  onClose,
  onOpenFull,
  header,
  children,
  footer,
  className,
}: {
  label: string
  onClose: () => void
  onOpenFull?: () => void
  header?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  // A click opens the record in a side sheet so people keep their place in the list (§10.5). Esc closes it.
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [onClose])
  return (
    <aside
      aria-label={label}
      className={cn(
        "flex max-h-[calc(100vh-32px)] w-full flex-col overflow-hidden rounded-[10px] border border-divider bg-surface lg:sticky lg:top-4 lg:w-[400px] lg:shrink-0",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-divider px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">{header}</div>
        {onOpenFull && (
          <button type="button" aria-label="Open full page" onClick={onOpenFull} className="rounded p-1 hover:bg-hover">
            <Maximize2 className="size-4" />
          </button>
        )}
        <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 hover:bg-hover">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
      {footer && <div className="flex flex-wrap items-center gap-2 border-t border-divider px-4 py-3">{footer}</div>}
    </aside>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-hover", className)} />
}

export function LoadingRows({ rows = 6, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="flex flex-col gap-2 p-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  )
}

export function LoadingPage() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <Skeleton className="h-7 w-72" />
      <Skeleton className="h-4 w-96" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-80" />
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-6 py-10 text-center", className)}>
      {icon && <div className="mb-1 text-subtle">{icon}</div>}
      <div className="font-semibold">{title}</div>
      {children && <div className="max-w-md text-[13px] text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorState({
  title = "Couldn't load this",
  message,
  onRetry,
}: {
  title?: React.ReactNode
  message?: React.ReactNode
  onRetry?: () => void
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <AlertTriangle aria-hidden className="size-6 text-st-red" />
      <div className="font-semibold">{title}</div>
      <div className="max-w-md text-[13px] text-muted-foreground">{message ?? "Nothing was lost. Try again."}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 h-[30px] rounded-md border border-border bg-surface px-3 text-[13px] font-medium hover:bg-hover"
        >
          Try again
        </button>
      )}
    </div>
  )
}

export function NoPermission({ message }: { message?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <Lock aria-hidden className="size-6 text-subtle" />
      <div className="font-semibold">You don't have access to this page</div>
      <div className="max-w-md text-[13px] text-muted-foreground">
        {message ?? "Ask Samantha (system owner) if you think you should."}
      </div>
    </div>
  )
}

export function Callout({
  tone = "grey",
  icon,
  children,
  className,
}: {
  tone?: "red" | "amber" | "blue" | "grey" | "green"
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-[13.5px]",
        tone === "red" && "bg-st-red-bg text-st-red",
        tone === "amber" && "bg-st-amber-bg text-st-amber",
        tone === "blue" && "bg-st-blue-bg text-st-blue",
        tone === "grey" && "bg-st-grey-bg text-ink2",
        tone === "green" && "bg-st-green-bg text-st-green",
        className,
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function Avatar({ initials, className }: { initials: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-border text-[11.5px] font-semibold text-ink2",
        className,
      )}
    >
      {initials}
    </span>
  )
}

export function Mark({ size = 24, className }: { size?: number; className?: string }) {
  // The bide Comply mark: a single "b" on a rounded square (design: Brand). Replaceable in Settings › Appearance.
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center bg-primary font-bold text-primary-foreground", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.29), fontSize: Math.round(size * 0.5) }}
    >
      b
    </span>
  )
}
