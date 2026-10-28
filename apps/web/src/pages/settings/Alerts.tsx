/*
 * Alert rules (CMS-08, design: AlertRules). The escalation ladder 1-3, the Class A failure rule that can't be muted,
 * the other triggers, quiet hours, and a tester that walks an example through the saved rules.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Lock, Plus, X } from "lucide-react"
import * as React from "react"

import { api, type ApiError } from "@bide-comply/api-client"
import { Callout, ErrorState, NoPermission, PageHeader, Skeleton } from "@bide-comply/ui/components/page"
import { Popover, PopoverContent, PopoverTrigger } from "@bide-comply/ui/components/popover"
import { Switch } from "@bide-comply/ui/components/switch"
import { toast } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { errText, NativeSelect, Panel, ToggleChip } from "../../features/settings-b/ui"
import { useMe } from "../../lib/session"

type Recipient = { kind: string; role?: string; id?: string; label: string }
type Channel = { key: string; label: string; on: boolean }
type Rule = {
  trigger: string
  step: number | null
  title: string
  note: string | null
  recipients: Recipient[]
  channels: Channel[]
  mutable: boolean
  own_rule: boolean
  class_a: boolean
}
type AlertsData = {
  rules: Rule[]
  quiet_hours: { enabled: boolean; from: string; until: string }
  properties: { id: string; name: string }[]
  can_edit: boolean
  examples: { key: string; label: string }[]
}
type TestResult = { steps: string[]; class?: string; what?: string }
type PersonRow = { id: string; name: string; title: string }

// Channels people can switch. Push follows the app setting and is kept as it is.
const SHOWN = ["app", "slack_dm", "slack_channel", "email", "phone"]
// Class A alerts can't be muted: these always stay on (the API enforces it too).
const CLASS_A_LOCKED = ["app", "slack_dm", "phone"]
const ROLE_RECIPIENTS: Recipient[] = [
  { kind: "doer", label: "The person who does it" },
  { kind: "cover", label: "Their cover" },
  { kind: "site_lead", label: "Site lead" },
  { kind: "dutyholders", label: "The property's SPV directors" },
  { kind: "accountable", label: "The accountable person" },
]
const CLASS_A_WHAT = "alarm or ARC down, no keyholder cover, escape route blocked, FRA missing"
const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
)

const sameRecipient = (a: Recipient, b: Recipient) =>
  a.kind === b.kind && (a.role ?? null) === (b.role ?? null) && (a.id ?? null) === (b.id ?? null)

export function AlertsPage() {
  const me = useMe()
  const qc = useQueryClient()
  const [propertyId, setPropertyId] = React.useState<string>("")
  const q = useQuery<AlertsData, ApiError>({
    queryKey: ["settings", "alerts", propertyId],
    queryFn: () => api.get<AlertsData>("/api/settings/alerts", { property: propertyId || undefined }),
  })
  const [rules, setRules] = React.useState<Rule[]>([])
  const [quiet, setQuiet] = React.useState<AlertsData["quiet_hours"]>({ enabled: true, from: "21:00", until: "07:00" })
  const [dirty, setDirty] = React.useState<Set<string>>(new Set())
  const [quietDirty, setQuietDirty] = React.useState(false)

  React.useEffect(() => {
    if (!q.data) return
    setRules(q.data.rules)
    setQuiet(q.data.quiet_hours)
    setDirty(new Set())
    setQuietDirty(false)
  }, [q.data])

  const canEdit = !!(me.data?.can["policy.escalation"] && q.data?.can_edit)
  const changed = dirty.size > 0 || quietDirty

  const update = (trigger: string, fn: (r: Rule) => Rule) => {
    setRules((rs) => rs.map((r) => (r.trigger === trigger ? fn(r) : r)))
    setDirty((d) => new Set(d).add(trigger))
  }

  const save = useMutation<{ ok: boolean }, ApiError>({
    mutationFn: () => {
      // For one property, only the rules changed here (or already its own) become property rules.
      const send = propertyId ? rules.filter((r) => dirty.has(r.trigger) || r.own_rule) : rules
      return api.put("/api/settings/alerts", {
        property_id: propertyId || null,
        rules: send.map((r) => ({
          trigger: r.trigger,
          recipients: r.recipients.map(({ label: _label, ...rest }) => rest),
          channels: r.channels.filter((c) => c.on).map((c) => c.key),
          note: r.note,
        })),
        quiet_hours: quiet,
      })
    },
    onSuccess: () => {
      toast.success(propertyId ? "Rules saved for this property." : "Rules saved for all properties.")
      void qc.invalidateQueries({ queryKey: ["settings", "alerts"] })
    },
    onError: (e) => toast.error(errText(e)),
  })

  if (me.data && !me.data.can["settings.view"]) return <NoPermission />

  const ladder = rules.filter((r) => r.step && !r.class_a)
  const classA = rules.find((r) => r.class_a)
  const other = rules.filter((r) => !r.step)
  const propName = q.data?.properties.find((p) => p.id === propertyId)?.name

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Alert rules"
        subtitle="Who gets told, and when, if something slips."
        actions={
          <>
            <NativeSelect
              label="Applies to"
              prefix="Applies to"
              value={propertyId}
              onChange={(v) => {
                if (changed && !window.confirm("You have unsaved changes. Switch anyway and lose them?")) return
                setPropertyId(v)
              }}
              options={[
                { value: "", label: "All properties" },
                ...(q.data?.properties ?? []).map((p) => ({ value: p.id, label: p.name })),
              ]}
              className="h-9"
            />
            {canEdit && (
              <button
                type="button"
                disabled={!changed || save.isPending}
                onClick={() => save.mutate()}
                className="inline-flex h-9 items-center rounded-md bg-primary px-3.5 text-[13.5px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                {save.isPending ? "Saving…" : "Save rules"}
              </button>
            )}
          </>
        }
      />

      {q.isError ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex flex-col gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-36" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-0 flex-col gap-3">
            {!canEdit && (
              <Callout tone="grey" icon={<Lock className="size-4" />}>
                You can see these rules but not change them. Super Admins can.
              </Callout>
            )}
            {propertyId && (
              <Callout tone="blue">
                Rules for {propName}. A rule saved here overrides the all-properties one for {propName} only.
              </Callout>
            )}
            <section aria-label="Ladder" className="flex flex-col gap-3">
              {ladder.map((r, i) => (
                <RuleCard
                  key={r.trigger}
                  rule={r}
                  canEdit={canEdit}
                  onChange={(fn) => update(r.trigger, fn)}
                  marker={<StepMarker step={r.step ?? i + 1} />}
                  propertyScoped={!!propertyId}
                />
              ))}
              {classA && (
                <RuleCard
                  rule={classA}
                  canEdit={canEdit}
                  onChange={(fn) => update(classA.trigger, fn)}
                  propertyScoped={!!propertyId}
                  marker={
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                      <AlertTriangle aria-hidden className="size-5" />
                    </span>
                  }
                />
              )}
            </section>

            <section aria-label="Other alerts" className="rounded-[10px] border border-divider bg-surface pt-[18px]">
              <h2 className="m-0 mb-1 px-[18px] text-[14px] font-semibold">Other alerts</h2>
              <p className="m-0 px-[18px] text-[13px] text-muted-foreground">
                Sent as they happen. Quiet hours hold them overnight unless they are Class A.
              </p>
              <ul className="m-0 mt-2 list-none p-0">
                {other.map((r) => (
                  <li key={r.trigger} className="border-t border-divider px-[18px] py-3.5">
                    <RuleBody
                      rule={r}
                      canEdit={canEdit}
                      onChange={(fn) => update(r.trigger, fn)}
                      propertyScoped={!!propertyId}
                    />
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="flex flex-col gap-4">
            <Panel title="Quiet hours" aria-label="Quiet hours">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="quiet-switch" className="text-[13.5px]">
                  Hold non-urgent alerts overnight
                </label>
                <Switch
                  id="quiet-switch"
                  checked={quiet.enabled}
                  disabled={!canEdit}
                  aria-label={quiet.enabled ? "Quiet hours on" : "Quiet hours off"}
                  onCheckedChange={(v) => {
                    setQuiet((s) => ({ ...s, enabled: v }))
                    setQuietDirty(true)
                  }}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                {(["from", "until"] as const).map((k) => (
                  <div key={k}>
                    <div className="mb-1.5 text-[12.5px] font-medium text-ink2">{k === "from" ? "From" : "Until"}</div>
                    <NativeSelect
                      label={k === "from" ? "Quiet hours from" : "Quiet hours until"}
                      value={quiet[k]}
                      disabled={!canEdit || !quiet.enabled}
                      onChange={(v) => {
                        setQuiet((s) => ({ ...s, [k]: v }))
                        setQuietDirty(true)
                      }}
                      options={TIMES.map((t) => ({ value: t, label: t }))}
                      className="tabular h-9 w-full"
                    />
                  </div>
                ))}
              </div>
              <p className="m-0 mt-3 text-[12.5px] text-muted-foreground">Class A alerts always go through.</p>
            </Panel>

            <TestRules examples={q.data.examples} />
          </div>
        </div>
      )}
    </div>
  )
}

function StepMarker({ step }: { step: number }) {
  return (
    <span
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-lg text-[15px] font-semibold",
        step === 1 && "bg-st-amber-bg text-st-amber",
        step === 2 && "bg-st-red-bg text-st-red",
        step >= 3 && "bg-st-red text-white dark:text-black",
      )}
    >
      <span className="sr-only">Step </span>
      {step}
    </span>
  )
}

function RuleCard({
  rule,
  marker,
  canEdit,
  onChange,
  propertyScoped,
}: {
  rule: Rule
  marker: React.ReactNode
  canEdit: boolean
  onChange: (fn: (r: Rule) => Rule) => void
  propertyScoped: boolean
}) {
  return (
    <article
      aria-label={rule.title}
      className={cn(
        "flex gap-3.5 rounded-[10px] border bg-surface p-[18px]",
        rule.class_a ? "border-st-red/40" : "border-divider",
      )}
    >
      <div className="flex flex-col items-center gap-0">
        {marker}
        {!rule.class_a && <span aria-hidden className="mt-2 w-px flex-1 bg-divider" />}
      </div>
      <div className="min-w-0 flex-1">
        <RuleBody rule={rule} canEdit={canEdit} onChange={onChange} propertyScoped={propertyScoped} />
      </div>
    </article>
  )
}

function RuleTitle({ rule }: { rule: Rule }) {
  if (rule.class_a) return <>{`${rule.title}: ${CLASS_A_WHAT}`}</>
  if (rule.trigger === "red_7days") {
    const [a, b] = rule.title.split("7 days")
    if (b !== undefined)
      return (
        <>
          {a}
          <span className="mx-0.5 inline-flex h-7 items-center rounded-md border border-border px-2 align-middle font-medium">
            7 days
          </span>
          {b}
        </>
      )
  }
  return <>{rule.title}</>
}

function RuleBody({
  rule,
  canEdit,
  onChange,
  propertyScoped,
}: {
  rule: Rule
  canEdit: boolean
  onChange: (fn: (r: Rule) => Rule) => void
  propertyScoped: boolean
}) {
  const chans = rule.channels.filter((c) => SHOWN.includes(c.key))
  const firstPerson = rule.recipients.find((r) => r.kind === "role" || r.kind === "person")?.label.split(",")[0]
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <h3 className="m-0 flex flex-wrap items-center gap-x-1 text-[14px] leading-7 font-semibold">
          <RuleTitle rule={rule} />
          {propertyScoped && rule.own_rule && (
            <span className="ml-1.5 inline-flex h-5 items-center rounded-full bg-st-blue-bg px-2 text-[11.5px] font-medium text-st-blue">
              This property's own rule
            </span>
          )}
        </h3>
        {rule.note && <p className="m-0 text-[13px] text-muted-foreground">{rule.note}</p>}
      </div>
      <Recipients
        rule={rule}
        canEdit={canEdit}
        onRemove={(x) => onChange((r) => ({ ...r, recipients: r.recipients.filter((y) => !sameRecipient(x, y)) }))}
        onAdd={(x) =>
          onChange((r) =>
            r.recipients.some((y) => sameRecipient(x, y)) ? r : { ...r, recipients: [...r.recipients, x] },
          )
        }
      />
      <div role="group" aria-label="Channels" className="flex flex-wrap gap-1.5">
        {chans.map((c) => {
          const locked = rule.class_a && CLASS_A_LOCKED.includes(c.key)
          return (
            <ToggleChip
              key={c.key}
              on={c.on || locked}
              locked={locked}
              disabled={!canEdit}
              title={locked ? "Class A alerts can't be muted" : undefined}
              onToggle={() =>
                onChange((r) => ({
                  ...r,
                  channels: r.channels.map((x) => (x.key === c.key ? { ...x, on: !x.on } : x)),
                }))
              }
            >
              {locked && <Lock aria-hidden className="size-3 opacity-70" />}
              {c.label}
            </ToggleChip>
          )
        })}
      </div>
      {rule.class_a && (
        <div className="rounded-lg bg-st-grey-bg px-3 py-2.5 text-[13.5px] text-foreground">
          Also asks {firstPerson ?? "the Super Admin"} to record the stop-sell decision: close affected rooms in Mews,
          or agree an interim measure with the assessor.
        </div>
      )}
    </div>
  )
}

function Recipients({
  rule,
  canEdit,
  onRemove,
  onAdd,
}: {
  rule: Rule
  canEdit: boolean
  onRemove: (r: Recipient) => void
  onAdd: (r: Recipient) => void
}) {
  return (
    <ul aria-label="Who is told" className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
      {rule.recipients.map((r) => (
        <li
          key={`${r.kind}-${r.role ?? ""}-${r.id ?? ""}`}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-hover pr-1 pl-2.5 text-[13px]"
        >
          {r.label}
          {canEdit && rule.recipients.length > 1 ? (
            <button
              type="button"
              aria-label={`Remove ${r.label}`}
              onClick={() => onRemove(r)}
              className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-border hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          ) : (
            <span className="w-1.5" />
          )}
        </li>
      ))}
      {canEdit && (
        <li>
          <AddRecipient existing={rule.recipients} onAdd={onAdd} />
        </li>
      )}
    </ul>
  )
}

function AddRecipient({ existing, onAdd }: { existing: Recipient[]; onAdd: (r: Recipient) => void }) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState("")
  const people = useQuery<{ rows: PersonRow[] }, ApiError>({
    queryKey: ["people", "all-for-alerts"],
    queryFn: () => api.get("/api/people", { page_size: 500 }),
    enabled: open,
    staleTime: 60_000,
  })
  const t = text.trim().toLowerCase()
  const roles = ROLE_RECIPIENTS.filter((r) => !existing.some((x) => sameRecipient(x, r))).filter(
    (r) => !t || r.label.toLowerCase().includes(t),
  )
  const persons = (people.data?.rows ?? [])
    .filter((p) => !existing.some((x) => x.kind === "person" && x.id === p.id))
    .filter((p) => !t || p.name.toLowerCase().includes(t))
  const pick = (r: Recipient) => {
    onAdd(r)
    setOpen(false)
    setText("")
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] font-medium text-link hover:bg-hover"
        >
          <Plus aria-hidden className="size-3.5" /> Add
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Find a person or role"
          aria-label="Find a person or role"
          className="mb-1 h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] outline-none focus:outline-2 focus:outline-focus"
        />
        <div className="max-h-72 overflow-y-auto">
          {roles.length > 0 && (
            <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">By role</div>
          )}
          {roles.map((r) => (
            <button
              key={r.kind}
              type="button"
              onClick={() => pick(r)}
              className="block w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover"
            >
              {r.label}
            </button>
          ))}
          <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">People</div>
          {people.isLoading && <div className="px-2 py-1.5 text-[13px] text-muted-foreground">Loading people…</div>}
          {people.isError && <div className="px-2 py-1.5 text-[13px] text-muted-foreground">Couldn't load people.</div>}
          {persons.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pick({ kind: "person", id: p.id, label: p.name })}
              className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-hover"
            >
              <span className="text-[13px]">{p.name}</span>
              {p.title && <span className="text-xs text-muted-foreground">{p.title}</span>}
            </button>
          ))}
          {people.data && persons.length === 0 && roles.length === 0 && (
            <div className="px-2 py-1.5 text-[13px] text-muted-foreground">Nobody matches “{text}”.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TestRules({ examples }: { examples: AlertsData["examples"] }) {
  const [example, setExample] = React.useState(examples[0]?.key ?? "")
  const t = useQuery<TestResult, ApiError>({
    queryKey: ["settings", "alerts", "test", example],
    queryFn: () => api.get<TestResult>("/api/settings/alerts/test", { example }),
    enabled: !!example,
  })
  return (
    <Panel title="Test the rules" aria-label="Test the rules">
      <p className="m-0 mb-3 text-[13px] text-muted-foreground">
        Pick an example to see exactly who would hear about it, and when.
      </p>
      <NativeSelect
        label="Example"
        value={example}
        onChange={setExample}
        options={examples.map((e) => ({ value: e.key, label: e.label }))}
        className="h-9 w-full"
      />
      {t.isError ? (
        <p className="m-0 mt-3 text-[13px] text-st-red">{t.error.message}</p>
      ) : !t.data ? (
        <div className="mt-3 flex flex-col gap-2">
          <Skeleton className="h-4" />
          <Skeleton className="h-4" />
          <Skeleton className="h-4" />
        </div>
      ) : (
        <ol aria-live="polite" className="m-0 mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-[13px]">
          {t.data.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      <p className="m-0 mt-3 text-[12px] text-subtle">Uses the saved rules. Save first to test a change.</p>
    </Panel>
  )
}
