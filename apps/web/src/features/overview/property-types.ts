/* Response shapes for the One property screen (apps/api/bide_comply/api/register.py and home.py). */
import type { Facet, QuickView } from "@bide-comply/ui/components/filter-bar"
import type { Rag } from "@bide-comply/ui/components/status"

export type PropertyDetail = {
  id: string
  name: string
  code: string
  town: string | null
  dutyholder: string | null
  stage: "trading" | "pre_opening" | "setup" | string
  stage_label: string
  stage_note: string | null
  trading_since: string | null
  opening_date: string | null
  register_loaded: boolean
  score: number | null
  score_status: Rag
  status_label: string
  red_line: boolean
  class_a_late: number
  checks: { late: number; soon: number; ok: number; na: number; total: number }
  actions: { open: number; urgent: number; soon: number; later: number; late: number; urgent_late: number }
  gate: {
    status: "not_ready" | "ready_to_open" | "trading_a_open"
    applicable: number
    done: number
    percent: number
    class_a_open: number
    class_a_applicable: number
    class_a_done: number
    to_confirm: number
  } | null
  due_14: number
  certs_60: number
  last_alarm_test: string | null
  days_since_alarm_test: number | null
  note: string
  certificates_count: number
  alarm_events_count: number
  legal_hold: boolean
}

export type RegisterRow = {
  id: string
  ref: string
  check: string
  class: "A" | "B" | "C"
  kind: string
  domain: string
  domain_key: string
  status: Rag
  status_reason: string | null
  status_label: string
  next_due_on: string | null
  next_due_label: string
  done_by: string
  done_by_kind: "person" | "pool" | "contractor" | null
  accountable: string | null
  cover: string | null
  frequency_label: string
  last_done_on: string | null
  last_done_label: string
  needs_owner: boolean
  state: string
  switch_off_pending: boolean
}

export type RegisterList = {
  rows: RegisterRow[]
  total: number
  views: QuickView[]
  facets: Facet[]
  summary: string
  any_filter: boolean
  of_total: number
  groups: { key: string; name: string; count: number; red: number; rows: RegisterRow[] }[]
}

export type ActionRow = {
  id: string
  ref: string
  type: string
  type_label: string
  source_label: string
  gate_ref: string | null
  description: string
  class: string | null
  priority: "high" | "med" | "low"
  priority_label: string
  owner: string | null
  raised_on: string
  due_on: string
  left: string
  late: boolean
  status: string
  status_label: string
}

export type RegisterDetail = RegisterRow & {
  property: string
  property_code: string
  property_id: string
  class_label: string
  kind_label: string
  legal_basis: string | null
  guidance: string | null
  accountable_id: string | null
  cover_id: string | null
  verifier: string | null
  frequency_reason: string | null
  next_due_text: string
  blocked: { text: string; action_ref: string; certificate_fail: boolean } | null
  evidence: { id: string; name: string | null; kind: "pdf" | "submission"; detail: string }[]
  actions: ActionRow[]
  history: { at: string | null; date?: string | null; text: string; who: string | null }[]
  certificates: { id: string; title: string; issued_on: string | null; expires_on: string | null; fail_count: number; filing: string }[]
  can_assign: boolean
  can_toggle: boolean
  notes: string | null
}

export type Option = { id: string; name: string; sub: string | null }
export type AssignOptions = { people: Option[]; pools: Option[]; contractors: Option[] }
