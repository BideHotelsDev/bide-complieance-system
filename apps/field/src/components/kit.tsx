/*
 * Staff-app building blocks (design: AppToday … AppMe). Big tap targets (48px and up) for gloved thumbs, 16px inputs so
 * iOS never zooms, one primary action per screen in the thumb zone at the bottom.
 */
import { Link } from "@tanstack/react-router"
import { cn } from "@bide-comply/ui/lib/utils"
import { ChevronDown, ChevronLeft, User, Clock, File, Check, X } from "lucide-react"
import * as React from "react"

import { OfflineBanner } from "./sync"

export function Page({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn("mx-auto flex min-h-dvh w-full max-w-[480px] flex-col bg-background md:max-w-[56rem]", className)}
    >
      {children}
    </div>
  )
}

/* Phones get the whole width; tablets and laptops (md and up) a wider column, so the app isn't a phone-sized strip
   in the middle of the screen. Forms keep a readable width inside it (FlowScreen). Page above does this. */

/* A main tab: title block, content, and the tab bar (bottom on phones, top on wider screens). */
export function TabScreen({
  title,
  subtitle,
  header,
  children,
}: {
  title?: React.ReactNode
  subtitle?: React.ReactNode
  header?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Page>
      <OfflineBanner />
      <header className="border-b border-divider bg-surface px-[18px] pt-5 pb-3.5 md:px-6 md:pt-6">
        {header ?? (
          <>
            <h1 className="m-0 text-[1.5rem] leading-tight font-semibold">{title}</h1>
            {subtitle && <p className="m-0 mt-1 text-[0.90625rem] text-muted-foreground">{subtitle}</p>}
          </>
        )}
      </header>
      <main className="flex flex-1 flex-col gap-2.5 px-4 pt-4 pb-6 md:px-6 md:pt-5">{children}</main>
      <TabBar />
    </Page>
  )
}

const TABS = [
  { to: "/", label: "Today", icon: Check },
  { to: "/history", label: "History", icon: Clock },
  { to: "/documents", label: "My documents", icon: File },
  { to: "/me", label: "Me", icon: User },
] as const

export function TabBar() {
  return (
    // At the bottom on phones (thumb reach); along the top on wider screens, where a bottom bar reads as a phone app.
    <nav
      aria-label="App"
      className="pb-safe sticky bottom-0 z-20 grid grid-cols-4 border-t border-divider bg-surface md:top-0 md:bottom-auto md:order-first md:flex md:justify-start md:gap-1 md:border-t-0 md:border-b md:px-4 md:pb-0"
    >
      {TABS.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          activeOptions={{ exact: true }}
          className="flex min-h-[60px] flex-col items-center justify-center gap-1 text-[0.75rem] font-medium text-muted-foreground no-underline aria-[current=page]:font-semibold aria-[current=page]:text-foreground md:min-h-14 md:flex-row md:gap-2 md:border-b-2 md:border-transparent md:px-4 md:text-[0.9375rem] md:hover:text-foreground md:aria-[current=page]:border-foreground"
        >
          <t.icon aria-hidden className="size-[22px]" strokeWidth={1.75} />
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

/* A step away from the tabs: back arrow, title, content, and a sticky footer for the one primary action. */
export function FlowScreen({
  title,
  subtitle,
  right,
  back = "/",
  backLabel = "Back",
  footer,
  children,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  right?: React.ReactNode
  back?: string
  backLabel?: string
  footer?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Page>
      <OfflineBanner />
      <header className="sticky top-0 z-20 flex min-h-[64px] items-center gap-1 border-b border-divider bg-surface py-2 pr-3 pl-1.5">
        <Link
          to={back}
          aria-label={backLabel}
          className="flex size-12 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-hover"
        >
          <ChevronLeft aria-hidden className="size-6" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate text-[1.0625rem] leading-tight font-semibold">{title}</h1>
          {subtitle && <p className="m-0 mt-0.5 truncate text-[0.875rem] text-muted-foreground">{subtitle}</p>}
        </div>
        {right}
      </header>
      <main className="flex w-full flex-1 flex-col gap-5 px-4 pt-4 pb-6 md:mx-auto md:max-w-[40rem] md:pt-6">
        {children}
      </main>
      {footer && (
        <footer className="pb-safe-3 sticky bottom-0 z-20 border-t border-divider bg-surface px-4 pt-3">
          <div className="pb-3 md:mx-auto md:max-w-[40rem]">{footer}</div>
        </footer>
      )}
    </Page>
  )
}

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h2 className={cn("m-0 mt-2 text-[0.875rem] font-semibold text-muted-foreground", className)}>{children}</h2>
}

export function FieldLabel({
  children,
  help,
  htmlFor,
  id,
}: {
  children: React.ReactNode
  help?: React.ReactNode
  htmlFor?: string
  id?: string
}) {
  return (
    <div className="mb-2">
      <label htmlFor={htmlFor} id={id} className="block text-[1rem] leading-snug font-semibold">
        {children}
      </label>
      {help && <p className="m-0 mt-0.5 text-[0.875rem] text-muted-foreground">{help}</p>}
    </div>
  )
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border border-divider bg-surface", className)}>{children}</div>
}

/* The primary button: full width, 52px, in the footer. */
export function PrimaryButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-[1.0625rem] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:bg-subtle disabled:text-primary-foreground disabled:opacity-70",
        className,
      )}
    />
  )
}

export function SecondaryButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[1rem] font-semibold text-foreground hover:bg-hover disabled:opacity-50",
        className,
      )}
    />
  )
}

/* Two or more choices as big buttons (Yes / No, Pass / Fail). aria-pressed carries the state, and an icon backs up
   the colour. Picked, an answer that passes (tone "pass") goes solid green with a tick, one that fails (tone "fail")
   solid red with a cross, and a neutral one dark with a tick: there's no doubt from arm's length what was answered. */
export function Choice<T extends string>({
  value,
  options,
  onChange,
  labelledBy,
}: {
  value: T | null | undefined
  options: { value: T; label: string; tone?: "pass" | "fail" }[]
  onChange: (v: T) => void
  labelledBy?: string
}) {
  return (
    <div role="group" aria-labelledby={labelledBy} className="grid grid-cols-2 gap-2">
      {options.map((o) => {
        const on = value === o.value
        const Icon = on && o.tone === "fail" ? X : Check
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-12 items-center justify-center gap-1.5 rounded-xl border text-[1rem] font-semibold transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
              !on && "border-border bg-surface text-foreground hover:bg-hover",
              on && o.tone === "fail" && "border-st-red bg-st-red text-surface",
              on && o.tone === "pass" && "border-st-green bg-st-green text-surface",
              on && !o.tone && "border-foreground bg-foreground text-background",
            )}
          >
            {on && <Icon aria-hidden className="size-[1.125rem]" strokeWidth={2.75} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/* A native select (the phone's own picker), styled like the design's dropdown button with an optional hint. */
export function SelectBox({
  id,
  value,
  onChange,
  options,
  placeholder = "Choose",
  hint,
  ariaLabel,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  hint?: React.ReactNode
  ariaLabel?: string
}) {
  return (
    <div className="relative">
      <select
        id={id}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-12 w-full appearance-none rounded-xl border border-border bg-surface pr-10 pl-3.5 text-[1rem] text-foreground",
          hint && "pr-40",
          !value && "text-muted-foreground",
        )}
      >
        {!value && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center gap-1.5 text-[0.84375rem] text-muted-foreground">
        {hint}
        <ChevronDown aria-hidden className="size-4" />
      </span>
    </div>
  )
}

export function TextInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={cn(
        "h-12 w-full rounded-xl border border-border bg-surface px-3.5 text-[1rem] text-foreground",
        className,
      )}
    />
  )
}

export function TextArea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      rows={3}
      {...props}
      className={cn(
        "min-h-[88px] w-full rounded-xl border border-border bg-surface px-3.5 py-3 text-[1rem] leading-snug text-foreground",
        className,
      )}
    />
  )
}

/* An on/off switch row (design: AppMe › Notifications). */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex min-h-[56px] w-full items-center gap-3 px-3.5 py-2.5 text-left disabled:opacity-60"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[0.96875rem]">{label}</span>
        {hint && <span className="block text-[0.84375rem] text-muted-foreground">{hint}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          "relative h-7 w-12 shrink-0 rounded-full transition-colors",
          checked ? "bg-primary" : "bg-border",
        )}
      >
        <span
          className={cn(
            "absolute top-1 size-5 rounded-full bg-surface shadow transition-transform",
            checked ? "translate-x-6" : "translate-x-1",
          )}
        />
      </span>
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  )
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-[72px] animate-pulse rounded-xl bg-hover" />
      ))}
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-divider bg-surface px-5 py-8 text-center"
    >
      <p className="m-0 text-[0.9375rem]">{message}</p>
      {onRetry && (
        <SecondaryButton className="w-auto px-6" onClick={onRetry}>
          Try again
        </SecondaryButton>
      )}
    </div>
  )
}
