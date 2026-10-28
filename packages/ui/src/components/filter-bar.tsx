/*
 * Lists (design: Components › Filters): quick views first, labelled filters second, a sentence to confirm.
 * The server computes every count with the other filters applied; this component only renders what it is given
 * and reports changes, so filter state can live in the URL (shareable, works with Back).
 */
import * as React from "react"
import { Check, ChevronDown, Search, X } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "../lib/utils"

export type QuickView = { key: string; label: string; count: number; on: boolean }
export type FacetOption = { value: string; label: string; count: number; checked: boolean }
export type Facet = { key: string; name: string; hint?: string; value: string; options: FacetOption[]; active: boolean }

export function QuickViews({
  views,
  onPick,
  label = "Quick views",
}: {
  views: QuickView[]
  onPick: (key: string) => void
  label?: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
      {views.map((v) => (
        <button
          key={v.key}
          role="tab"
          type="button"
          aria-selected={v.on}
          onClick={() => onPick(v.key)}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors",
            v.on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-ink2 hover:bg-hover",
          )}
        >
          {v.label}
          <span
            className={cn(
              "tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11.5px] font-semibold",
              v.on ? "bg-white/20 text-primary-foreground" : "bg-hover text-ink2",
            )}
          >
            {v.count}
          </span>
        </button>
      ))}
    </div>
  )
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  count,
  className,
  autoFocusKey = "/",
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  count?: number | null
  className?: string
  autoFocusKey?: string | null
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  const [local, setLocal] = React.useState(value)
  React.useEffect(() => setLocal(value), [value])
  // Debounced about 250 ms, from 2 characters (§10.3).
  React.useEffect(() => {
    if (local === value) return
    const t = setTimeout(() => {
      if (local.trim().length === 0 || local.trim().length >= 2) onChange(local)
    }, 250)
    return () => clearTimeout(t)
  }, [local, value, onChange])
  React.useEffect(() => {
    if (!autoFocusKey) return
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === autoFocusKey && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault()
        ref.current?.focus()
      }
    }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [autoFocusKey])
  return (
    <label
      className={cn(
        "flex h-8 min-w-[220px] items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-muted-foreground focus-within:outline-2 focus-within:outline-focus",
        className,
      )}
    >
      <Search aria-hidden className="size-4 shrink-0" />
      <input
        ref={ref}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
      />
      {local && count != null && <span className="tabular shrink-0 text-xs">{count} results</span>}
      {local ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setLocal("")
            onChange("")
          }}
          className="rounded p-0.5 hover:bg-hover"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        autoFocusKey && (
          <kbd className="rounded border border-border px-1 font-sans text-[11px] text-subtle">{autoFocusKey}</kbd>
        )
      )}
    </label>
  )
}

export function FacetButton({ facet, onChange }: { facet: Facet; onChange: (values: string[]) => void }) {
  const [open, setOpen] = React.useState(false)
  const selected = facet.options.filter((o) => o.checked).map((o) => o.value)
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] whitespace-nowrap transition-colors",
            facet.active
              ? "border-st-blue bg-st-blue-bg text-st-blue"
              : "border-border bg-surface text-ink2 hover:bg-hover",
          )}
        >
          <span className={cn(!facet.active && "text-muted-foreground")}>{facet.name}</span>
          <span className="font-medium">{facet.value}</span>
          <ChevronDown aria-hidden className="size-3.5 opacity-70" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          aria-label={facet.name}
          className="z-50 w-64 rounded-lg border border-border bg-popover p-1.5 shadow-lg"
        >
          {facet.hint && <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">{facet.hint}</div>}
          <div role="listbox" aria-multiselectable="true" className="max-h-72 overflow-y-auto">
            {facet.options.map((o) => (
              <div key={o.value} className="group flex items-center rounded-md hover:bg-hover">
                <label
                  className={cn(
                    "flex flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-[13px]",
                    o.count === 0 && !o.checked && "text-subtle",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={o.checked}
                    onChange={() => toggle(o.value)}
                    className="size-4 accent-[var(--c-primary)]"
                  />
                  <span className="flex-1 truncate">{o.label}</span>
                  <span className="tabular text-xs text-muted-foreground">{o.count}</span>
                </label>
                <button
                  type="button"
                  onClick={() => onChange([o.value])}
                  className="mr-1 rounded px-1.5 py-0.5 text-xs text-link opacity-0 group-hover:opacity-100 focus:opacity-100"
                >
                  Only
                </button>
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between border-t border-divider px-1 pt-1.5">
            <button type="button" className="rounded px-2 py-1 text-xs hover:bg-hover" onClick={() => onChange([])}>
              Clear
            </button>
            <button
              type="button"
              className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
              onClick={() => setOpen(false)}
            >
              Done
            </button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

export function FilterBar({
  facets,
  onFacet,
  search,
  anyFilter,
  onClearAll,
  children,
}: {
  facets: Facet[]
  onFacet: (key: string, values: string[]) => void
  search?: React.ReactNode
  anyFilter?: boolean
  onClearAll?: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {search}
      {facets.map((f) => (
        <FacetButton key={f.key} facet={f} onChange={(v) => onFacet(f.key, v)} />
      ))}
      {anyFilter && onClearAll && (
        <button type="button" onClick={onClearAll} className="h-8 rounded-md px-2 text-[13px] text-link hover:bg-hover">
          Clear all filters
        </button>
      )}
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  )
}

/* A sentence says exactly what is on screen, so nobody misreads a filtered list as the whole picture. */
export function Summary({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p aria-live="polite" className={cn("m-0 text-[13px] text-muted-foreground", className)}>
      {children}
    </p>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "default",
}: {
  value: T
  options: { value: T; label: React.ReactNode }[]
  onChange: (v: T) => void
  label: string
  size?: "default" | "sm"
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border bg-sidebar p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 font-medium transition-colors",
            size === "sm" ? "h-6 text-xs" : "h-[26px] text-[13px]",
            value === o.value ? "bg-surface text-foreground shadow-[0_0_0_1px_var(--c-border)]" : "text-muted-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function SelectedTick() {
  return <Check aria-hidden className="size-4" />
}
