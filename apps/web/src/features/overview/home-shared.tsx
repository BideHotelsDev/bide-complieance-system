/*
 * Small helpers shared by Home and My to-do: an in-app link for server-built hrefs ("/actions?sel=TM-044"), a phone
 * breakpoint hook, and the response shapes of /api/overview, /api/mobile-home and /api/todo.
 */
import { useRouter } from "@tanstack/react-router"
import * as React from "react"

import { greeting } from "@/lib/format"

export function AppLink({
  href,
  children,
  ...props
}: Omit<React.ComponentProps<"a">, "href" | "onClick"> & { href: string }) {
  const router = useRouter()
  return (
    <a
      {...props}
      href={href}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        void router.navigate({ href })
      }}
    >
      {children}
    </a>
  )
}

export function useMediaQuery(query: string): boolean {
  const get = React.useCallback(() => typeof window !== "undefined" && window.matchMedia(query).matches, [query])
  const [on, setOn] = React.useState(get)
  React.useEffect(() => {
    const m = window.matchMedia(query)
    const h = () => setOn(m.matches)
    h()
    m.addEventListener("change", h)
    return () => m.removeEventListener("change", h)
  }, [query])
  return on
}

export type Rag = "green" | "amber" | "red" | "grey"

export type PropertySummary = {
  id: string
  name: string
  code: string
  town: string | null
  dutyholder: string | null
  stage: "trading" | "pre_opening" | "setup" | string
  stage_label: string
  stage_note: string | null
  opening_date: string | null
  register_loaded: boolean
  score: number | null
  score_status: Rag
  status_label: string
  red_line: boolean
  class_a_late: number
  checks: { late: number; soon: number; ok: number; na: number; total: number }
  actions: {
    open: number
    urgent: number
    soon: number
    later: number
    late: number
    urgent_late: number
    urgent_over_7: number
  }
  gate: {
    status: "not_ready" | "ready_to_open" | "trading_a_open"
    applicable: number
    done: number
    percent: number
    class_a_open: number
  } | null
  due_14: number
  certs_60: number
  last_alarm_test: string | null
  days_since_alarm_test: number | null
  note: string | null
}

export type TodoItem = {
  kind: "call" | "action" | "approval"
  approval_kind?: string
  id: string
  icon: string
  title: string
  detail: string
  link: string
  action_ref?: string
  call_due?: boolean
  due_on?: string
  class: string | null
  property?: string | null
}

export type Overview = {
  updated_at: string
  today: string
  banner: { text: string; extra: string | null; link: string } | null
  kpis: {
    life_safety_open: { value: number; properties: number; goal: number }
    urgent_late: { value: number; of: number; goal: number }
    on_time: { value: number | null; prev: number | null; goal: number; definition: string }
    decisions: { value: number; advisories: number; signoffs: number }
  }
  properties: PropertySummary[]
  group: {
    score: number | null
    class_a_late: number
    overdue: number
    due_14: number
    urgent_open: number
    certs_60: number
  }
  needs_you: TodoItem[]
  actions_by_urgency: { high: number; med: number; low: number }
  on_time_trend: { week: string; label: string; on_time: number | null; due: number }[]
  actions_trend: { week: string; label: string; opened: number; closed: number }[]
  gate_open: { property_id: string; property: string; class_a_open: number; opened: boolean }[]
  next_certificates: { id: string; title: string; property: string; expires_on: string; days: number }[]
  heatmap: {
    domains: { key: string; name: string }[]
    rows: {
      property_id: string
      property: string
      cells: { domain: string; status: string | null; counts: Record<string, number> }[]
    }[]
  }
}

export type MobileHome = {
  first_name: string
  needs: TodoItem[]
  total?: number
  signatures?: { id: string; title: string; property: string; due_on: string | null }[]
  properties: PropertySummary[]
}

export type Todo = {
  now: TodoItem[]
  counts: { everything: number; decisions: number; reviews: number; actions: number; today: number }
  reviews: { pending: number; spot_check: number }
  mine?: {
    id: string
    ref: string
    title: string
    property: string
    priority: "high" | "med" | "low"
    due_on: string
    class: string | null
    link: string
  }[]
  signatures: { id: string; title: string; property: string; due_on: string | null }[]
  coming: { date: string; label: string; text: string; strong?: boolean }[]
}

/* "Opens Apr 2027" */
export function opensLabel(d: string | null): string {
  if (!d) return "Opening date not set"
  const date = new Date(`${d}T12:00:00Z`)
  return `Opens ${date.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "Europe/London" })}`
}

/* "Elderberry Hall and bide Stays" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/* "Good morning, David"; placeholder people ("[Site lead, The View]") get no first name. */
export function hello(name: string | null | undefined, firstName: string | null | undefined): string {
  if (!name || name.startsWith("[") || !firstName) return greeting()
  return `${greeting()}, ${firstName}`
}
