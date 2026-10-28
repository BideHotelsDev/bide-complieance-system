/*
 * Small pieces shared by the insight screens (scorecard, reports, assessor walk, help, account).
 */
import * as React from "react"

import { cn } from "@bide-comply/ui/lib/utils"

/* Native select / date input styled like the design's 36px fields */
export const fieldCls =
  "h-9 w-full rounded-md border border-border bg-surface px-3 text-[13.5px] text-foreground outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30"

export function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium">
        {label}
      </label>
      {children}
    </div>
  )
}

/* A simple underline tab bar (design: Reports tabs). Real buttons with aria-selected. */
export function TabBar<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: React.ReactNode }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-5 border-b border-divider">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "-mb-px h-9 border-b-2 text-[14px] font-medium",
            value === o.value
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older browsers or no permission: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand("copy")
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
