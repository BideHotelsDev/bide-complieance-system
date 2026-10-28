/*
 * The competent assessor's quarterly audit walk (design: Assessor audit walk). Walk the building and compare it with
 * what the register says. Every answer saves as you go; anything that doesn't match becomes an Action with the
 * assessor's priority and photos when the report is sent. Built for a tablet: big targets, one column of rows.
 */
import { Link, useParams as useRouteParams } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Camera, Check, Loader2 } from "lucide-react"
import * as React from "react"

import { api, ApiError, upload } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Card, EmptyState, ErrorState, LoadingPage, NoPermission, PageHeader } from "@bide-comply/ui/components/page"
import { ClassBadge, Pill } from "@bide-comply/ui/components/status"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { fmtDate, fmtDateTime } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useMe } from "@/lib/session"

type Verdict = "matches" | "doesnt" | "cant_check"
type Priority = "high" | "med" | "low"
type Photo = { id: string; url: string; thumb_url: string | null; file_name: string }
type Item = {
  register_item_id: string
  ref: string
  check: string
  class: string
  group: string
  register_says: string
  verdict: Verdict | null
  finding: string | null
  priority: Priority | null
  action_ref: string | null
  photo_ids: string[]
  photos: Photo[]
}
type Walk = {
  walk_id: string
  property_id: string
  property: string
  code: string
  quarter: string
  status: string
  progress: { done: number; total: number }
  groups: { key: string; label: string; count: number }[]
  group: string
  items: Item[]
  tally: { matches: number; doesnt: number; cant_check: number; to_do: number }
  also_waiting: { title: string; due_on: string | null; priority?: Priority }[]
  can_finish: boolean
  sent_at: string | null
  action_owner: string | null
}
type Line = { verdict: Verdict | null; finding: string | null; priority: Priority | null; photo_ids: string[] }

const PRIORITY: { value: Priority; label: string; window: string }[] = [
  { value: "high", label: "Urgent", window: "7 days" },
  { value: "med", label: "Soon", window: "30 days" },
  { value: "low", label: "Later", window: "90 days" },
]

export function AssessorPage() {
  const { code } = useRouteParams({ strict: false }) as { code?: string }
  const me = useMe().data
  const [params, set] = useParams()
  const group = params.group ?? "fire"
  const q = useQuery<Walk, ApiError>({
    queryKey: ["audit-walk", code, group],
    queryFn: () => api.get<Walk>(`/api/audit-walks/${code}`, { group }),
    enabled: !!code,
    placeholderData: (prev) => (prev?.code.toLowerCase() === code?.toLowerCase() ? prev : undefined),
    retry: (n, e) => e.status >= 500 && n < 2,
  })
  if (!me) return null
  if (!me.can["assessor.walk"] && !me.is_admin)
    return <NoPermission message="Audit walks are recorded by the competent assessor." />
  if (q.isPending) return <LoadingPage />
  if (q.error)
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Quarterly audit walk"
          subtitle="Walk the building and compare it with what the register says."
        />
        <PropertyPicker current={code} />
        {q.error.status >= 500 || q.error.status === 0 ? (
          <Card>
            <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
          </Card>
        ) : (
          <p className="m-0 text-[13px] text-muted-foreground">
            {code ? `There's no audit walk you can open for “${code}”. ` : ""}Choose a property above to start or carry
            on its walk.
          </p>
        )}
      </div>
    )
  return <WalkView walk={q.data} group={group} onGroup={(g) => set({ group: g === "fire" ? undefined : g })} />
}

/* The assessor's properties, as links. Shown when no walk loads, and as a switcher when there is more than one. */
function PropertyPicker({ current, compact = false }: { current?: string; compact?: boolean }) {
  const me = useMe().data
  const props = me?.properties ?? []
  if (props.length === 0)
    return compact ? null : (
      <EmptyState title="No properties yet">Ask Samantha (system owner) to add you to a property.</EmptyState>
    )
  if (compact && props.length < 2) return null
  return (
    <nav
      aria-label="Your properties"
      className={cn(
        "flex flex-wrap items-center gap-2",
        !compact && "rounded-[10px] border border-divider bg-surface p-4",
      )}
    >
      <span className="mr-1 text-[13px] text-muted-foreground">{compact ? "Walks:" : "Your properties"}</span>
      {props.map((p) => {
        const on = p.code.toLowerCase() === current?.toLowerCase()
        return (
          <Link
            key={p.id}
            to="/assessor/$code"
            params={{ code: p.code }}
            search={{}}
            aria-current={on ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium no-underline",
              on
                ? "border-foreground bg-primary text-primary-foreground"
                : "border-border bg-surface text-foreground hover:bg-hover",
            )}
          >
            {p.name}
            <span className={cn("mono-id text-xs", on ? "opacity-80" : "text-muted-foreground")}>{p.code}</span>
          </Link>
        )
      })}
    </nav>
  )
}

function WalkView({ walk, group, onGroup }: { walk: Walk; group: string; onGroup: (g: string) => void }) {
  const qc = useQueryClient()
  const sent = walk.status === "sent"
  const refresh = React.useCallback(() => qc.invalidateQueries({ queryKey: ["audit-walk"] }), [qc])
  const send = useMutation({
    mutationFn: () => api.post<{ actions: string[] }>(`/api/audit-walks/${walk.walk_id}/send`),
    onSuccess: (r) => {
      toast(
        r.actions.length
          ? `Report sent. ${r.actions.length} ${r.actions.length === 1 ? "finding became an Action" : "findings became Actions"}: ${r.actions.join(", ")}.`
          : "Report sent. Everything matched the register.",
      )
      void refresh()
    },
    onError: (e: ApiError) => toastError(e.message, () => send.mutate()),
  })
  const { done, total } = walk.progress
  return (
    <div className="flex flex-col gap-4">
      <PropertyPicker current={walk.code} compact />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <PageHeader
            title={`Quarterly audit walk · ${walk.property}`}
            subtitle="Walk the building and compare it with what the register says. Anything that doesn't match becomes an Action with your priority. Works on a tablet."
            actions={
              sent ? (
                <Pill tone="green">Sent {walk.sent_at ? fmtDate(walk.sent_at) : ""}</Pill>
              ) : (
                <Pill tone="blue">
                  In progress · {done} of {total} done
                </Pill>
              )
            }
          />
          <div role="tablist" aria-label="Areas" className="flex flex-wrap gap-2">
            {walk.groups.map((g) => (
              <button
                key={g.key}
                type="button"
                role="tab"
                aria-selected={g.key === group}
                onClick={() => onGroup(g.key)}
                className={cn(
                  "inline-flex h-10 items-center gap-2 rounded-full border px-4 text-[14px] font-medium",
                  g.key === group
                    ? "border-foreground bg-primary text-primary-foreground"
                    : "border-border bg-surface hover:bg-hover",
                )}
              >
                {g.label}
                <span
                  className={cn(
                    "tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold",
                    g.key === group ? "bg-white/20" : "bg-hover text-ink2",
                  )}
                >
                  {g.count}
                </span>
              </button>
            ))}
          </div>

          <section
            aria-label="Register items to check"
            className="overflow-hidden rounded-[10px] border border-divider bg-surface"
          >
            <div className="hidden grid-cols-[44px_minmax(0,1fr)_244px_190px] gap-x-4 items-center border-b border-divider bg-background px-4 py-2.5 text-[13px] font-medium text-muted-foreground lg:grid">
              <span />
              <span>The register says</span>
              <span>On site, does it match?</span>
              <span>Finding</span>
            </div>
            {walk.items.length === 0 ? (
              <EmptyState title="Nothing to check in this area">
                No life-safety or statutory items in this area are live at {walk.property}.
              </EmptyState>
            ) : (
              walk.items.map((it) => (
                <Row key={it.register_item_id} item={it} walk={walk} disabled={sent} onSaved={refresh} />
              ))
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-4 xl:sticky xl:top-4">
          <Card bodyClassName="p-4">
            <h2 className="m-0 mb-3 text-[15px] font-semibold">This walk so far</h2>
            <dl className="m-0 grid grid-cols-[1fr_auto] gap-y-2.5 text-[14px]">
              <dt>Matches the register</dt>
              <dd className="tabular m-0 text-right font-semibold">{walk.tally.matches}</dd>
              <dt>Doesn't match</dt>
              <dd className={cn("tabular m-0 text-right font-semibold", walk.tally.doesnt > 0 && "text-st-red")}>
                {walk.tally.doesnt}
              </dd>
              <dt>Couldn't check</dt>
              <dd className="tabular m-0 text-right font-semibold">{walk.tally.cant_check}</dd>
              <dt>Still to do</dt>
              <dd className="tabular m-0 text-right font-semibold">{walk.tally.to_do}</dd>
            </dl>
            <Button
              size="lg"
              className="mt-4 w-full"
              disabled={!walk.can_finish || send.isPending}
              onClick={() => send.mutate()}
              aria-describedby="finish-note"
            >
              {send.isPending && <Loader2 className="animate-spin" aria-hidden />}
              {sent ? "Report sent" : "Finish and send report"}
            </Button>
            <p id="finish-note" className="m-0 mt-3 text-[12.5px] text-muted-foreground">
              {sent
                ? `Sent ${walk.sent_at ? fmtDateTime(walk.sent_at) : ""}. The findings are now Actions to fix.`
                : `Each "Doesn't match" becomes an Action owned by ${walk.action_owner?.split(" ")[0] ?? "the system owner"}, with your priority and photos. The directors and the dutyholder get your report.${
                    walk.can_finish ? "" : " You can send it once every item has an answer."
                  }`}
            </p>
          </Card>
          <Card bodyClassName="p-4">
            <h2 className="m-0 mb-3 text-[15px] font-semibold">Also waiting for you</h2>
            {walk.also_waiting.length === 0 ? (
              <p className="m-0 text-[13px] text-muted-foreground">Nothing else at {walk.property}.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {walk.also_waiting.map((a, i) => (
                  <li key={i} className="flex items-start gap-3 text-[14px]">
                    <span className="min-w-0 flex-1">{a.title}</span>
                    {a.due_on && <DueBadge priority={a.priority} due={a.due_on} />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  )
}

function DueBadge({ priority, due }: { priority?: Priority; due: string }) {
  const label = priority ? PRIORITY.find((p) => p.value === priority)?.label : "Due"
  if (priority === "high")
    return (
      <span className="inline-flex h-[22px] shrink-0 items-center rounded-full px-2 text-[12.5px] font-semibold whitespace-nowrap shadow-[inset_0_0_0_1.5px_var(--c-foreground)]">
        {label} · {fmtDate(due)}
      </span>
    )
  return (
    <Pill tone="amber">
      {label} · {fmtDate(due)}
    </Pill>
  )
}

function Row({ item, walk, disabled, onSaved }: { item: Item; walk: Walk; disabled: boolean; onSaved: () => void }) {
  const [line, setLine] = React.useState<Line>(() => ({
    verdict: item.verdict,
    finding: item.finding,
    priority: item.priority,
    photo_ids: item.photo_ids,
  }))
  const [photos, setPhotos] = React.useState<Photo[]>(item.photos)
  const [saving, setSaving] = React.useState<"idle" | "saving" | "saved">("idle")
  const [uploading, setUploading] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const timer = React.useRef<number | undefined>(undefined)
  const latest = React.useRef(line)

  async function save(l: Line): Promise<void> {
    setSaving("saving")
    try {
      await api.put(`/api/audit-walks/${walk.walk_id}/lines`, { register_item_id: item.register_item_id, ...l })
      setSaving("saved")
      onSaved()
    } catch (e) {
      setSaving("idle")
      toastError(
        e instanceof ApiError ? e.message : "Couldn't save that answer. Try again.",
        () => void save(latest.current),
      )
    }
  }
  // Save straight away for taps; wait for a pause in typing for the finding.
  const change = (patch: Partial<Line>, debounce = false) => {
    const next = { ...line, ...patch }
    latest.current = next
    setLine(next)
    window.clearTimeout(timer.current)
    if (debounce) timer.current = window.setTimeout(() => void save(next), 700)
    else void save(next)
  }
  React.useEffect(() => () => window.clearTimeout(timer.current), [])

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true)
    try {
      const added: Photo[] = []
      for (const f of Array.from(files)) {
        const u = await upload(f, { captured_with: "camera", property_id: walk.property_id })
        added.push({ id: u.id, url: u.url, thumb_url: u.thumb_url, file_name: u.file_name })
      }
      setPhotos((p) => [...p, ...added])
      change({ photo_ids: [...line.photo_ids, ...added.map((a) => a.id)] })
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : "The photo didn't upload. Try again.")
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const doesnt = line.verdict === "doesnt"
  const prio = PRIORITY.find((p) => p.value === (line.priority ?? "high"))
  const findingId = `finding-${item.register_item_id}`
  return (
    <div className={cn("border-b border-divider last:border-b-0", doesnt && "bg-st-red-bg/40")}>
      <div className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-y-3 px-4 py-3.5 lg:grid-cols-[44px_minmax(0,1fr)_244px_190px] lg:gap-x-4">
        <span>
          <ClassBadge klass={item.class} />
        </span>
        <span className="min-w-0">
          <span className="block font-medium">{item.check}</span>
          <span className="block text-[13px] text-muted-foreground">
            <span className="mono-id">{item.ref}</span> · {item.register_says}
          </span>
        </span>
        <span className="col-start-2 lg:col-start-auto">
          <span
            role="group"
            aria-label={`Does ${item.check} match the register?`}
            className="inline-flex overflow-hidden rounded-lg border border-border"
          >
            {(
              [
                ["matches", "Matches"],
                ["doesnt", "Doesn't"],
                ["cant_check", "Can't check"],
              ] as const
            ).map(([v, label]) => {
              const on = line.verdict === v
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() =>
                    change({
                      verdict: on ? null : v,
                      priority: v === "doesnt" && !line.priority ? "high" : line.priority,
                    })
                  }
                  className={cn(
                    "h-11 min-w-[72px] border-r border-border px-3 text-[13.5px] leading-tight font-medium last:border-r-0 disabled:cursor-not-allowed",
                    on && v === "matches" && "bg-st-green-bg text-st-green",
                    on && v === "doesnt" && "bg-st-red-bg text-st-red",
                    on && v === "cant_check" && "bg-st-grey-bg text-ink2",
                    !on && "bg-surface hover:bg-hover",
                  )}
                >
                  {label}
                </button>
              )
            })}
          </span>
        </span>
        <span className="col-start-2 flex items-center gap-2 text-[13.5px] lg:col-start-auto">
          {item.action_ref ? (
            <Pill tone="outline">Action {item.action_ref}</Pill>
          ) : doesnt ? (
            <span className="inline-flex h-[22px] items-center rounded-full px-2 text-[12.5px] font-semibold shadow-[inset_0_0_0_1.5px_var(--c-foreground)]">
              New finding · {prio?.label}
            </span>
          ) : line.verdict === "cant_check" ? (
            <span className="text-muted-foreground">Couldn't check</span>
          ) : line.verdict === "matches" ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="text-muted-foreground">Not checked yet</span>
          )}
          <span aria-live="polite" className="ml-auto text-xs text-muted-foreground">
            {saving === "saving" ? (
              "Saving"
            ) : saving === "saved" ? (
              <Check className="size-3.5 text-st-green" aria-label="Saved" />
            ) : null}
          </span>
        </span>
      </div>

      {doesnt && (
        <div className="flex flex-col gap-4 px-4 pb-5 lg:pl-[60px]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={findingId} className="text-[13px] font-medium">
              What did you find?
            </label>
            <textarea
              id={findingId}
              rows={2}
              disabled={disabled}
              value={line.finding ?? ""}
              placeholder="For example: doors 104 and 106 do not latch from 45°. Closers need adjusting."
              onChange={(e) => change({ finding: e.target.value }, true)}
              onBlur={() => {
                if (timer.current) {
                  window.clearTimeout(timer.current)
                  void save(latest.current)
                }
              }}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-[14px] outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30"
            />
          </div>
          <div className="flex flex-wrap gap-6">
            <div className="flex flex-col gap-1.5">
              <span id={`prio-${item.register_item_id}`} className="text-[13px] font-medium">
                Priority
              </span>
              <span
                role="radiogroup"
                aria-labelledby={`prio-${item.register_item_id}`}
                className="inline-flex overflow-hidden rounded-lg border border-border bg-surface"
              >
                {PRIORITY.map((p) => {
                  const on = (line.priority ?? "high") === p.value
                  return (
                    <button
                      key={p.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={disabled}
                      onClick={() => change({ priority: p.value })}
                      className={cn(
                        "h-11 border-r border-border px-4 text-[13.5px] font-medium last:border-r-0",
                        on
                          ? p.value === "high"
                            ? "bg-st-red-bg text-st-red"
                            : "bg-hover text-foreground"
                          : "hover:bg-hover",
                      )}
                    >
                      {p.label}
                      {on && ` · ${p.window}`}
                    </button>
                  )
                })}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Photos</span>
              <span className="flex flex-wrap items-center gap-2">
                {photos.map((ph) => (
                  <a
                    key={ph.id}
                    href={ph.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block size-11 overflow-hidden rounded-md border border-border bg-hover"
                    title={ph.file_name}
                  >
                    <img src={ph.thumb_url ?? ph.url} alt={ph.file_name} className="size-full object-cover" />
                  </a>
                ))}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => void onFiles(e.target.files)}
                />
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={disabled || uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? <Loader2 className="animate-spin" aria-hidden /> : <Camera aria-hidden />}
                  {uploading ? "Uploading" : "Photo"}
                </Button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
