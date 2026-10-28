/*
 * Small building blocks shared by the queue screens (Actions, Evidence review, Approvals, Sign-offs, Opening
 * checklists). Local to this feature so the shared UI kit stays untouched; colours come only from tokens.
 */
import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { Upload, X } from "lucide-react"

import { cn } from "@bide-comply/ui/lib/utils"

/* Header stat card (design: .sc) */
export function StatCard({
  col = false,
  className,
  children,
}: {
  col?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 gap-3.5 rounded-xl border border-divider bg-surface px-4 py-3.5",
        col ? "flex-col items-stretch gap-2.5" : "items-center",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function StatTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] font-medium text-ink2">{children}</div>
}

export function StatBig({ value, sub }: { value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="mt-1 flex items-baseline gap-2">
      <span className="tabular text-[28px] leading-none font-semibold tracking-[-0.02em]">{value}</span>
      {sub && <span className="text-[12.5px] text-muted-foreground">{sub}</span>}
    </div>
  )
}

export function IconBox({ tone, children }: { tone: "red" | "amber" | "grey" | "green"; children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-[10px]",
        tone === "red" && "bg-st-red-bg text-st-red",
        tone === "amber" && "bg-st-amber-bg text-st-amber",
        tone === "grey" && "bg-st-grey-bg text-st-grey",
        tone === "green" && "bg-st-green-bg text-st-green",
      )}
    >
      {children}
    </span>
  )
}

export type Seg = { label: string; value: number; color: string; title?: string }

/* A ring for a small part-to-whole: several segments, or one segment out of a total */
export function Ring({
  segments,
  total,
  center,
  label,
  size = 84,
  stroke = 12,
}: {
  segments: Seg[]
  total?: number
  center: React.ReactNode
  label: string
  size?: number
  stroke?: number
}) {
  const r = (size - stroke) / 2 - 2
  const c = 2 * Math.PI * r
  const sum = total ?? segments.reduce((a, s) => a + s.value, 0)
  let off = 0
  const gap = segments.length > 1 ? 2 : 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--c-hover)" strokeWidth={stroke} />
      {sum > 0 &&
        segments.map((s) => {
          const len = (s.value / sum) * c
          const el =
            s.value > 0 ? (
              <circle
                key={s.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={stroke}
                strokeDasharray={`${Math.max(len - gap, 0.5)} ${c}`}
                strokeDashoffset={-off}
                strokeLinecap={segments.length === 1 ? "round" : "butt"}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              >
                <title>{`${s.title ?? s.label}: ${s.value}`}</title>
              </circle>
            ) : null
          off += len
          return el
        })}
      <text
        x={size / 2}
        y={size / 2 + 6}
        textAnchor="middle"
        fontSize={16}
        fontWeight={600}
        fill="var(--c-foreground)"
        className="tabular"
      >
        {center}
      </text>
    </svg>
  )
}

export function Legend({ items }: { items: Seg[] }) {
  return (
    <ul className="m-0 mt-1.5 flex min-w-0 list-none flex-col gap-[3px] p-0 text-[12.5px]">
      {items.map((s) => (
        <li key={s.label} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-[9px] shrink-0 rounded-[3px]" style={{ background: s.color }} />
          {s.label}
          <strong className="tabular ml-auto pl-2.5 font-semibold">{s.value}</strong>
        </li>
      ))}
    </ul>
  )
}

export function BarRow({ label, value, max, color = "var(--c-foreground)" }: { label: string; value: number; max: number; color?: string }) {
  return (
    <div className="grid grid-cols-[84px_1fr_26px] items-center gap-2 text-[12.5px]">
      <span className="truncate">{label}</span>
      <span className="block h-2.5 rounded bg-hover">
        <span
          className="block h-2.5 rounded"
          title={`${label}: ${value}`}
          style={{ width: `${max ? (value / max) * 100 : 0}%`, background: color }}
        />
      </span>
      <strong className="tabular text-right font-semibold">{value}</strong>
    </div>
  )
}

export function Progress({ value, total, height = 6, className }: { value: number; total: number; height?: number; className?: string }) {
  const pct = total ? Math.min(100, (value / total) * 100) : 0
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
      className={cn("block overflow-hidden rounded-[3px] bg-hover", className)}
      style={{ height }}
    >
      <span className="block bg-primary" style={{ height, width: `${pct}%` }} />
    </span>
  )
}

/* Underlined tabs (Evidence review queue, Approvals) */
export function LineTabs({
  tabs,
  value,
  onChange,
  label,
  size = "default",
  className,
}: {
  tabs: { key: string; label: string; count?: number | null }[]
  value: string
  onChange: (k: string) => void
  label: string
  size?: "default" | "sm"
  className?: string
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex overflow-x-auto border-b border-divider", size === "sm" ? "gap-3.5" : "gap-[22px]", className)}>
      {tabs.map((t) => {
        const on = t.key === value
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 whitespace-nowrap",
              size === "sm" ? "py-2 text-[13px]" : "py-2.5 text-[14px]",
              on ? "border-foreground font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              on && size === "sm" && "font-medium",
            )}
          >
            {t.label}
            {t.count != null &&
              (size === "sm" ? (
                <span className="tabular">{t.count}</span>
              ) : (
                <span className="tabular inline-flex h-[22px] items-center rounded-full bg-st-grey-bg px-2 text-[12.5px] font-medium text-st-grey">
                  {t.count}
                </span>
              ))}
          </button>
        )
      })}
    </div>
  )
}

/* Dialogs (design: Dialogs, sheets and confirmations): title + context line, body, footer named after the action */
export function QDialog({
  open,
  onOpenChange,
  title,
  sub,
  children,
  footer,
  alert = false,
  busy = false,
  width = 460,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: React.ReactNode
  sub?: React.ReactNode
  children?: React.ReactNode
  footer: React.ReactNode
  alert?: boolean
  busy?: boolean
  width?: number
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          role={alert ? "alertdialog" : "dialog"}
          onInteractOutside={(e) => busy && e.preventDefault()}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-32px)] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[14px] border border-border bg-surface shadow-[0_12px_32px_rgba(17,17,19,.10),0_2px_6px_rgba(17,17,19,.06)] outline-none"
          style={{ maxWidth: width }}
        >
          <div className="flex items-start gap-3 px-5 pt-[18px]">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogPrimitive.Title className="m-0 text-[16px] font-semibold">{title}</DialogPrimitive.Title>
              {sub ? (
                <DialogPrimitive.Description className="m-0 text-[13.5px] text-muted-foreground">{sub}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close aria-label="Close" className="rounded p-1 text-muted-foreground hover:bg-hover" disabled={busy}>
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="flex flex-col gap-3 overflow-y-auto px-5 py-3.5 text-[14px]">{children}</div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-divider px-5 pt-3 pb-4">{footer}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={cn("flex flex-col gap-[5px]", className)}>
      <span className="text-[12.5px] font-medium text-ink2">
        {label}
        {hint && <span className="font-normal text-muted-foreground"> {hint}</span>}
      </span>
      {children}
    </label>
  )
}

export const inputCls =
  "h-9 w-full rounded-lg border border-border bg-surface px-3 text-[14px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-focus"
export const textareaCls =
  "w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-focus"

export function Note({ icon, children, className }: { icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2.5 rounded-[10px] bg-st-grey-bg px-3.5 py-3 text-[13.5px] text-ink2", className)}>
      {icon && <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function Radio({
  on,
  onPick,
  title,
  sub,
}: {
  on: boolean
  onPick: () => void
  title: React.ReactNode
  sub?: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left",
        on ? "border-foreground shadow-[inset_0_0_0_1px_var(--c-foreground)]" : "border-border hover:bg-hover/50",
      )}
    >
      <span
        aria-hidden
        className={cn("mt-0.5 inline-block size-4 shrink-0 rounded-full", on ? "border-[5px] border-foreground" : "border-[1.5px] border-subtle")}
      />
      <span>
        <strong className="font-semibold">{title}</strong>
        {sub && <span className="block text-muted-foreground">{sub}</span>}
      </span>
    </button>
  )
}

/* Drop zone for closing evidence and gate proof: drop or pick a photo, scan or certificate */
export function DropZone({
  onFiles,
  busy,
  title = "Drop a photo, scan or certificate",
  sub,
  accept = "image/*,application/pdf",
}: {
  onFiles: (files: File[]) => void
  busy?: boolean
  title?: string
  sub?: React.ReactNode
  accept?: string
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  const [over, setOver] = React.useState(false)
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = Array.from(e.dataTransfer.files)
        if (f.length) onFiles(f)
      }}
      className={cn(
        "flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-[18px] text-center",
        over ? "border-focus bg-st-blue-bg" : "border-subtle",
      )}
    >
      <Upload aria-hidden className="size-5 text-muted-foreground" />
      <button
        type="button"
        disabled={busy}
        onClick={() => ref.current?.click()}
        className="font-medium text-foreground hover:underline disabled:opacity-50"
      >
        {busy ? "Uploading…" : title}
      </button>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      <input
        ref={ref}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = Array.from(e.target.files ?? [])
          e.target.value = ""
          if (f.length) onFiles(f)
        }}
      />
    </div>
  )
}

/* A list row used by the queue lists (Evidence review, Approvals, Sign-offs) */
export function rowCls(on: boolean) {
  return cn(
    "block w-full border-b border-divider text-left text-foreground no-underline last:border-b-0 hover:bg-hover/50",
    on && "bg-st-blue-bg/60 shadow-[inset_3px_0_0_var(--c-blue)] hover:bg-st-blue-bg/60",
  )
}

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  return ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable
}
