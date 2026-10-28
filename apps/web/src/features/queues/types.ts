/* Response shapes of the queue endpoints (apps/api/bide_comply/api/actions.py, reviews.py, approvals.py, gates.py) */
import type { Facet, QuickView } from "@bide-comply/ui/components/filter-bar"
import type { GateItemStatus, GateStatus, Priority } from "@bide-comply/ui/components/status"

export type ActionRow = {
  id: string
  ref: string
  property_id: string
  type: "action" | "work_required" | "advisory"
  type_label: string
  source: string
  source_label: string
  gate_ref: string | null
  description: string
  class: "A" | "B" | "C" | null
  priority: Priority
  priority_label: string
  window: string
  owner_id: string | null
  owner: string | null
  owner_is_role: boolean
  raised_on: string
  due_on: string
  left: string
  late: boolean
  status: "open" | "to_confirm" | "closed"
  status_label: string
  closed_on: string | null
  decision: string | null
  decision_reason: string | null
  call_due: boolean
  register_item_id: string | null
  property: string
  property_code: string
}

export type ActionList = {
  rows: ActionRow[]
  total: number
  page: number
  page_size: number
  views: QuickView[]
  facets: Facet[]
  summary: string
  any_filter: boolean
  stats: {
    by_urgency: Record<Priority, number>
    by_property: { property: string; count: number }[]
    urgent_late: number
    urgent_total: number
    open_total: number
  }
  board: Record<Priority, ActionRow[]>
}

export type EvidenceFile = {
  id: string
  kind: string
  file_name: string
  content_type: string
  size_bytes: number
  sha256: string
  captured_at: string | null
  captured_with?: string
  url: string
  thumb_url: string | null
  original_url: string
}

export type ActionDetail = ActionRow & {
  evidence: (EvidenceFile & { purpose: string })[]
  comments: { id: string; body: string; author: string; at: string }[]
  item_ref: string | null
  interim_measure: string | null
  stop_sell_decision: string | null
  call_made_at: string | null
  can_close: boolean
  close_label: string
  close_hint: string
}

export type Person = { id: string; name: string; sub: string | null }

export type QueueCard = {
  id: string
  ref: string
  class: "A" | "B" | "C" | null
  title: string
  detail: string
  badge: string
  badge_tone: "red" | "amber" | "grey" | "blue"
}

export type ReviewQueue = {
  queues: { key: string; label: string; count: number }[]
  rows: QueueCard[]
}

export type ReviewDetail = {
  id: string
  ref: string
  class: "A" | "B" | "C" | null
  title: string
  status: string
  result: string
  subtitle: string
  verification_rule: string
  photos: (EvidenceFile & { required: string | null; stamp: string; taken: string | null })[]
  photo_count: number
  original_kept: boolean
  duplicate_found: boolean
  answers: { label: string; value: string; failed: boolean }[]
  notes: string | null
  presence: {
    submitted_by: string
    work_done: string
    server_time: string
    device_time: string | null
    location: string
    device: string
    photo_hash: string | null
    captured_offline: boolean
    back_filed: boolean
  }
  flags: string[]
  verifications: { result: string; comment: string | null; by: string; at: string }[]
  amendments: { reason: string; reason_type: string; changes: Record<string, unknown>; by: string; at: string }[]
  can_verify: boolean
  own: boolean
  can_amend: boolean
  task_id: string
}

export type ApprovalCard = {
  id: string
  kind: string
  title: string
  sub: string
  status: "waiting" | "approved" | "declined"
  decided_by: string | null
  decision_note: string | null
}

export type ApprovalList = {
  tabs: { key: string; label: string; count: number | null }[]
  rows: ApprovalCard[]
  all_waiting: ApprovalCard[]
}

export type ApprovalDetail = {
  id: string
  kind: string
  status: "waiting" | "approved" | "declined"
  class: "A" | "B" | "C" | null
  property: string | null
  reason: string | null
  note: string | null
  requested_by: string | null
  decided_by: string | null
  decision_note: string | null
  ref: string | null
  can_decide: boolean
  own: boolean
  checks: string[]
  title: string
  facts: { label: string; value: string | null }[]
}

export type SignRequest = {
  id: string
  type: "fra" | "quarterly" | "gate" | "fra_countersign" | "advisory" | string
  title: string
  subject?: string | null
  detail: string
  due_on: string | null
  status: "open" | "scheduled" | "locked" | string
  file_name?: string | null
  evidence_id?: string | null
  preconditions?: { done: boolean; text: string }[]
  action_ref?: string
}

export type SignoffProperty = {
  property_id: string
  code: string
  property: string
  town: string | null
  dutyholder: string | null
  status: "green" | "amber" | "red" | "grey"
  red_line: boolean
  gate_a_open: number | null
  urgent_open: number
  insurer: { label: string; due_on: string } | null
  requests: SignRequest[]
  awaiting: number
}

export type GateRow = {
  property_id: string
  code: string
  property: string
  status: GateStatus
  status_label: string
  applicable: number
  done: number
  percent: number
  class_a_open: number
  to_confirm: number
  actions_open: number
  opening_date: string | null
  stage: string
}

export type GateItem = {
  id: string
  ref: string
  section: string
  item: string
  class: "A" | "B" | "C"
  legal_basis: string | null
  evidence_required: string | null
  applies: boolean
  na_reason: string | null
  status: GateItemStatus
  status_label: string
  done_without_evidence: boolean
  owner: string | null
  due_on: string | null
  evidence_link: string | null
  evidence: { id: string; name: string }[]
  notes: string | null
  wording_pending: boolean
  actions: number
}

export type GateSection = {
  key: string
  name: string
  total: number
  done: number
  a_open: number
  in_progress: number
  to_confirm: number
  not_started: number
}

export type GateDetail = {
  property_id: string
  code: string
  property: string
  dutyholder: string | null
  stage: string
  trading_since: string | null
  opening_date: string | null
  subtitle: string
  status: GateStatus
  status_label: string
  summary: {
    applicable: number
    done: number
    percent: number
    class_a_open: number
    class_a_applicable: number
    class_a_done: number
    to_confirm: number
    actions_urgent: number
    actions_other: number
    actions_overdue: number
    advisories_open: number
  }
  sections: GateSection[]
  selected_section: string
  items: GateItem[]
  signoff: {
    can_sign: boolean
    unlocked: boolean
    signed: { by: string; at: string } | null
    class_a_done: number
    class_a_applicable: number
    signer: string
  }
  can_edit: boolean
}
