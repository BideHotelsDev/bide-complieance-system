/*
 * Small pieces shared by the Settings screens (library, form builder, property setup, import, people). Dialogs follow
 * the design's pattern (Dialogs, sheets and confirmations): a title, a line saying what it is about, the body, and a
 * footer whose main button is named after the action.
 */
import * as React from "react"
import { ApiError } from "@bide-comply/api-client"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@bide-comply/ui/components/dialog"
import { cn } from "@bide-comply/ui/lib/utils"

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return "Something went wrong. Nothing was saved. Try again."
}

export function ActionDialog({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
  busy = false,
  className,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: React.ReactNode
  subtitle?: React.ReactNode
  children?: React.ReactNode
  footer: React.ReactNode
  busy?: boolean
  className?: string
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        showCloseButton={false}
        className={cn("gap-0 overflow-hidden rounded-xl border-border bg-surface p-0 sm:max-w-[440px]", className)}
      >
        <div className="px-5 pt-5 pb-1">
          <DialogTitle className="text-[17px] leading-snug font-semibold">{title}</DialogTitle>
          {subtitle ? (
            <DialogDescription className="mt-1 text-[13.5px] text-muted-foreground">{subtitle}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{typeof title === "string" ? title : "Dialog"}</DialogDescription>
          )}
        </div>
        {children && <div className="flex flex-col gap-3 px-5 pt-3 pb-5 text-[13.5px]">{children}</div>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-divider px-5 py-3.5">{footer}</div>
      </DialogContent>
    </Dialog>
  )
}

export function Labeled({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  children: React.ReactNode
  className?: string
  htmlFor?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-ink2">
        {label}
      </label>
      {children}
      {hint && !error && <div className="text-xs text-muted-foreground">{hint}</div>}
      {error && (
        <div role="alert" className="text-xs text-st-red">
          {error}
        </div>
      )}
    </div>
  )
}

const control =
  "h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2.5 text-[13.5px] text-foreground outline-none focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60 aria-[invalid=true]:border-st-red"

export function TextInput({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(control, className)} {...props} />
}

export function TextArea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(control, "h-auto min-h-[64px] py-1.5", className)} {...props} />
}

export function NativeSelect({
  className,
  options,
  placeholder,
  ...props
}: Omit<React.ComponentProps<"select">, "children"> & {
  options: { value: string; label: string; disabled?: boolean }[]
  placeholder?: string
}) {
  return (
    <select className={cn(control, "cursor-pointer pr-7", className)} {...props}>
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/* "has_fire_alarm" -> "Has fire alarm" */
export function humanise(key: string): string {
  const s = key.replace(/_/g, " ").trim()
  const special: Record<string, string> = {
    "pre 2000": "Built before 2000",
    unmanned: "Unmanned",
    "has cctv": "Has CCTV",
    "has salto": "Has Salto locks",
    "sponsor licence": "Sponsor licence",
    "visitor levy": "Visitor levy",
  }
  if (special[s]) return special[s]
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value)
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
