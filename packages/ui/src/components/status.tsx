/*
 * One status vocabulary everywhere (PRD §10.2, design: Foundations › Status vocabulary). Status is never colour
 * alone: every badge carries its word, and Class and priority are monochrome so they never compete with status.
 */
import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "../lib/utils"

export type Tone = "green" | "amber" | "red" | "grey" | "blue" | "outline" | "solid-amber" | "outline-red" | "ink"

const TONE: Record<Tone, string> = {
  green: "bg-st-green-bg text-st-green",
  amber: "bg-st-amber-bg text-st-amber",
  red: "bg-st-red-bg text-st-red",
  grey: "bg-st-grey-bg text-st-grey",
  blue: "bg-st-blue-bg text-st-blue",
  outline: "border border-border text-st-grey",
  "solid-amber": "bg-st-amber text-white dark:text-black",
  "outline-red": "border border-st-red text-st-red",
  ink: "bg-primary text-primary-foreground",
}

export function Pill({
  tone = "grey",
  dot = false,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & { tone?: Tone; dot?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-full px-2 text-[12.5px] leading-none font-medium whitespace-nowrap",
        TONE[tone],
        className,
      )}
      {...props}
    >
      {dot && <span aria-hidden className="inline-block size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/* Register item RAG (§4.2): Green In date, Amber Due soon, Red Overdue, Grey N/A */
export type Rag = "green" | "amber" | "red" | "grey"
const RAG_WORD: Record<Rag, string> = { green: "Green", amber: "Amber", red: "Red", grey: "Grey" }
const RAG_MEANING: Record<Rag, string> = { green: "In date", amber: "Due soon", red: "Overdue", grey: "N/A" }

export function RagBadge({
  status,
  label,
  long = false,
  className,
}: {
  status: Rag
  label?: string
  long?: boolean
  className?: string
}) {
  return (
    <Pill tone={status} dot className={className}>
      {label ?? (long ? `${RAG_WORD[status]} · ${RAG_MEANING[status]}` : RAG_WORD[status])}
    </Pill>
  )
}

/* Task lifecycle (§10.2) */
export type TaskStatus =
  | "scheduled"
  | "open"
  | "due_soon"
  | "overdue"
  | "submitted"
  | "passed"
  | "verified"
  | "failed"
  | "missed"
  | "na"

const TASK: Record<TaskStatus, { tone: Tone; label: string }> = {
  scheduled: { tone: "outline", label: "Scheduled" },
  open: { tone: "grey", label: "Open" },
  due_soon: { tone: "amber", label: "Due soon" },
  overdue: { tone: "solid-amber", label: "Overdue" },
  submitted: { tone: "blue", label: "Submitted" },
  passed: { tone: "green", label: "Passed" },
  verified: { tone: "green", label: "Verified" },
  failed: { tone: "red", label: "Failed" },
  missed: { tone: "outline-red", label: "Missed" },
  na: { tone: "grey", label: "N/A" },
}

export function TaskBadge({ status, label, className }: { status: TaskStatus; label?: string; className?: string }) {
  const t = TASK[status] ?? TASK.open
  return (
    <Pill tone={t.tone} className={cn(status === "na" && "line-through", className)}>
      {status === "verified" && <Check aria-hidden className="size-3" strokeWidth={2.4} />}
      {label ?? t.label}
    </Pill>
  )
}

/* Gate items and gate status (BH-CMP-002) */
export type GateItemStatus = "not_started" | "in_progress" | "to_confirm" | "done" | "na"
const GATE_ITEM: Record<GateItemStatus, { tone: Tone; label: string }> = {
  not_started: { tone: "outline", label: "Not started" },
  in_progress: { tone: "blue", label: "In progress" },
  to_confirm: { tone: "amber", label: "To confirm" },
  done: { tone: "green", label: "Done" },
  na: { tone: "grey", label: "N/A" },
}
export function GateItemBadge({ status, className }: { status: GateItemStatus; className?: string }) {
  const g = GATE_ITEM[status]
  return (
    <Pill tone={g.tone} className={className}>
      {g.label}
    </Pill>
  )
}

export type GateStatus = "not_ready" | "ready_to_open" | "trading_a_open"
const GATE: Record<GateStatus, { tone: Tone; label: string }> = {
  not_ready: { tone: "grey", label: "Not ready" },
  ready_to_open: { tone: "green", label: "Ready to open" },
  trading_a_open: { tone: "red", label: "Open · life-safety items missing" },
}
export function GateBadge({ status, className }: { status: GateStatus; className?: string }) {
  const g = GATE[status]
  return (
    <Pill tone={g.tone} dot={status !== "not_ready"} className={className}>
      {g.label}
    </Pill>
  )
}

/* Class A / B / C: monochrome square badge with a tooltip-friendly title */
const CLASS_NAME = { A: "Class A · Life safety", B: "Class B · Statutory", C: "Class C · bide standard" } as const
export function ClassBadge({ klass, className }: { klass: "A" | "B" | "C" | string | null | undefined; className?: string }) {
  if (!klass) return null
  const k = klass as "A" | "B" | "C"
  return (
    <span
      title={CLASS_NAME[k]}
      aria-label={CLASS_NAME[k]}
      className={cn(
        "inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] text-[11px] font-semibold",
        k === "A" && "bg-primary text-primary-foreground",
        k === "B" && "border border-subtle text-ink2",
        k === "C" && "border border-dashed border-subtle text-st-grey",
        className,
      )}
    >
      {k}
    </span>
  )
}

/* Priority: Urgent 7 days, Soon 30, Later 90. Monochrome on purpose. */
export type Priority = "high" | "med" | "low"
const PRIO: Record<Priority, { label: string; cls: string }> = {
  high: { label: "Urgent", cls: "bg-surface text-foreground shadow-[inset_0_0_0_1.5px_var(--c-foreground)] font-semibold" },
  med: { label: "Soon", cls: "bg-border text-ink2" },
  low: { label: "Later", cls: "border border-border text-st-grey" },
}
export function PriorityBadge({
  priority,
  withWindow = false,
  className,
}: {
  priority: Priority
  withWindow?: boolean
  className?: string
}) {
  const p = PRIO[priority]
  const days = { high: "7 days", med: "30 days", low: "90 days" }[priority]
  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center rounded-full px-2 text-[12.5px] leading-none font-medium whitespace-nowrap",
        p.cls,
        className,
      )}
    >
      {p.label}
      {withWindow && ` · ${days}`}
    </span>
  )
}

/* Evidence flags: captured offline, back-filed, outside geofence, clock skew, spot-check */
export function FlagBadge({ flag }: { flag: string }) {
  const warn = ["Outside geofence", "Clock skew", "Photo used before"].includes(flag)
  return <Pill tone={warn ? "amber" : "grey"}>{flag}</Pill>
}

/* The property score chip: turns red under the red-line rule even when the percentage is high. */
export function ScoreRing({
  score,
  status,
  size = 56,
  redLine = false,
}: {
  score: number | null
  status: Rag
  size?: number
  redLine?: boolean
}) {
  const r = (size - 6) / 2
  const c = 2 * Math.PI * r
  const pct = score ?? 0
  const color = { green: "var(--c-green)", amber: "var(--c-amber)", red: "var(--c-red)", grey: "var(--c-grey)" }[status]
  const title =
    score == null
      ? "No score yet"
      : redLine
        ? `Score ${score}%. Shown red because a life-safety (Class A) item is overdue, whatever the percentage.`
        : `Score ${score}%`
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} title={title}>
      <svg width={size} height={size} role="img" aria-label={title}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--c-divider)" strokeWidth={5} />
        {score != null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={5}
            strokeDasharray={`${(pct / 100) * c} ${c}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="tabular absolute inset-0 flex items-center justify-center text-[13px] font-semibold">
        {score == null ? "—" : `${score}%`}
      </span>
    </span>
  )
}
