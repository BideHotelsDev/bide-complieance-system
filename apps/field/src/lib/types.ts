/* Shapes the staff app reads from /api/field/* (apps/api/bide_comply/api/field.py). */

export type TaskCard = {
  task_id: string
  ref: string
  title: string
  full_title: string
  class: "A" | "B" | "C"
  life_safety: boolean
  property: string
  property_id: string
  subtitle: string
  due_at: string
  minutes: number | null
  badge: string
}

export type Today = {
  first_name: string
  date_label: string
  to_do_today: number
  overdue: TaskCard[]
  today: TaskCard[]
  upcoming: TaskCard[]
  streak_weeks: number
  properties: { id: string; name: string }[]
}

export type FieldType =
  | "checkbox"
  | "yes_no"
  | "pass_fail"
  | "pass_fail_items"
  | "number"
  | "text"
  | "select"
  | "location"
  | "photo"
  | "signature"
  | "file"
  | "date"

export type FormField = {
  key: string
  type: FieldType
  label: string
  help?: string
  required?: boolean
  fail_on?: string
  fail_text?: string
  unit?: string
  min?: number
  max?: number
  options?: string[]
  fail_options?: string[]
  items?: string[]
  source?: string
  suggested?: string
  min_photos?: number
  max_photos?: number
}

export type TaskDetail = {
  task_id: string
  ref: string
  title: string
  full_title: string
  property: string
  property_id: string
  frequency: string
  class: "A" | "B" | "C"
  class_label: string
  status: string
  status_note: string | null
  guidance: string | null
  example_photo_id: string | null
  form: FormField[]
  version: number
  due_at: string
  window_opens_at: string
  window_closes_at: string | null
  late_rule: string
  geofence_required: boolean
  can_submit: boolean
  rejected: { comment: string } | null
  can_request_na: boolean
}

export type FailedField = { key: string; label: string; value: unknown; why: string; text: string }

export type SubmitResult = {
  submission_id: string
  result: "passed" | "failed"
  status: string
  failed_fields: FailedField[]
  flags: string[]
  late: boolean
  item_status: string
  action: { ref: string; priority: string; due_on: string; owner: string | null; class_a: boolean } | null
  result_screen?: {
    title: string
    priority_label: string
    due_label: string
    owner: string | null
    class_a: boolean
    alerted?: string[]
  }
}

export type History = {
  send_again: { task_id: string; title: string; comment: string; by: string }[]
  groups: { label: string; rows: { id: string; title: string; detail: string; status: string }[] }[]
}

export type Documents = {
  all_set: boolean
  rows: {
    id: string
    title: string
    detail: string
    status: "ok" | "expiring" | "expired" | "pending" | "missing"
    label: string
    key: string
  }[]
  types: { key: string; name: string; renew_months: number | null }[]
}

export type FieldMe = {
  name: string
  title: string | null
  month: { on_time: number | null; done: number; problems: number }
  streak_days: number
  trusted_until: string | null
  preferences: Record<string, unknown>
}

export type Me = {
  id: string
  name: string
  first_name: string
  initials: string
  email: string | null
  title: string
  kind: "staff" | "external"
  roles: string[]
  properties: { id: string; name: string; code: string; town: string | null; stage: string }[]
  can: Record<string, boolean>
  preferences: Record<string, unknown>
  privacy_notice_seen: boolean
}

export type Location = { id: string; name: string; type: string }

export type VisitForm = {
  contractors: { id: string; name: string; trade: string | null }[]
  purposes: { label: string; register_item_id: string | null; links_to: string | null }[]
}
