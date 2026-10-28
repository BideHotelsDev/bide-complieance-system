/*
 * Small pieces shared by the Alert rules, Messages and wording, Appearance and Audit log screens.
 */
import * as React from "react"
import { ChevronDown } from "lucide-react"

import { ApiError } from "@bide-comply/api-client"
import { cn } from "@bide-comply/ui/lib/utils"

export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return "Something went wrong. Nothing was saved. Try again."
}

/* A native select dressed like the design's dropdown buttons: keyboard and screen readers get the real thing. */
export function NativeSelect({
  value,
  onChange,
  options,
  label,
  prefix,
  className,
  disabled,
  id,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  label: string
  prefix?: string
  className?: string
  disabled?: boolean
  id?: string
}) {
  return (
    <span
      className={cn(
        "relative inline-flex h-[30px] items-center rounded-md border border-border bg-surface text-[13px] focus-within:outline-2 focus-within:outline-focus",
        disabled && "opacity-60",
        className,
      )}
    >
      {prefix && (
        <span aria-hidden className="pointer-events-none pl-2.5 whitespace-nowrap text-muted-foreground">
          {prefix}
        </span>
      )}
      <select
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-full w-full min-w-0 cursor-pointer appearance-none bg-transparent pr-7 font-medium text-foreground outline-none",
          prefix ? "pl-1.5" : "pl-2.5",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
    </span>
  )
}

/* On/off chip for a channel: dark when on, outlined when off. The word stays, so it isn't colour alone. */
export function ToggleChip({
  on,
  onToggle,
  children,
  locked,
  disabled,
  title,
}: {
  on: boolean
  onToggle?: () => void
  children: React.ReactNode
  locked?: boolean
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled || locked}
      title={title}
      onClick={onToggle}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors",
        on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-ink2 hover:bg-hover",
        (disabled || locked) && "cursor-default",
        disabled && !locked && "opacity-70 hover:bg-surface",
      )}
    >
      {children}
    </button>
  )
}

export function Panel({
  title,
  action,
  children,
  className,
  "aria-label": ariaLabel,
}: {
  title?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  "aria-label"?: string
}) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn("rounded-[10px] border border-divider bg-surface p-[18px]", className)}
    >
      {(title || action) && (
        <div className="mb-3 flex items-center gap-3">
          {title && <h2 className="m-0 text-[14px] font-semibold">{title}</h2>}
          {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[12.5px] font-medium text-ink2">
      {children}
    </label>
  )
}

/* Pressed-button group used for corner radius, density and preview mode. */
export function ButtonGroup<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
}: {
  value: T
  options: { value: T; label: React.ReactNode }[]
  onChange: (v: T) => void
  label: string
  disabled?: boolean
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex rounded-md border border-border bg-surface p-0.5", className)}
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-[28px] flex-1 rounded-[5px] px-3 text-[13px] font-medium transition-colors disabled:cursor-default",
            value === o.value ? "bg-primary text-primary-foreground" : "text-ink2 hover:bg-hover",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
