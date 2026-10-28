/*
 * Settings › Property setup (design: RegisterSetup, CMS-05, CMS-10, CMS-12). Which templates apply at a property and
 * who does each one. Golden rule 2: a task with no owner does not get done, so activation waits until every row has
 * a real name. Switching a check off needs a reason (for site leads it becomes a request); changing how often needs
 * the FRA section or assessor decision that set it.
 */
import * as React from "react"
import { Link, useNavigate, useParams as useRouteParams } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ChevronDown, ClipboardList } from "lucide-react"
import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@bide-comply/ui/components/dropdown-menu"
import { FacetButton, QuickViews, SearchBox, type Facet, type QuickView } from "@bide-comply/ui/components/filter-bar"
import { Callout, EmptyState, ErrorState, LoadingRows, NoPermission, PageHeader } from "@bide-comply/ui/components/page"
import { ClassBadge, Pill } from "@bide-comply/ui/components/status"
import { Switch } from "@bide-comply/ui/components/switch"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { AssigneePicker, useAssignees, type Opt } from "../../features/settings-a/assignee"
import { useLibraryOptions } from "../../features/settings-a/library"
import { ActionDialog, errMsg, Labeled, NativeSelect, TextInput } from "../../features/settings-a/ui"
import { plural } from "../../lib/format"
import { list, useParams } from "../../lib/params"
import { useProperty } from "../../lib/property"
import { useMe } from "../../lib/session"

type Row = {
  template_id: string
  item_id: string | null
  ref: string | null
  template: string
  class: "A" | "B" | "C"
  domain: string
  applies: boolean
  proposed?: boolean
  frequency: string
  frequency_label: string
  frequency_default?: string | null
  frequency_reason?: string | null
  done_by: string
  done_by_kind?: "person" | "pool" | "contractor" | null
  accountable: string
  cover: string | null
  verifier: string | null
  setup: "ready" | "needs_owner" | "off" | "off_requested" | "not_added"
  off_reason?: string | null
  switch_off_request?: { id: string; reason: string; by: string | null } | null
  state?: string
  done_by_id?: string | null
  accountable_id?: string | null
  cover_id?: string | null
  verifier_id?: string | null
  verifier_mode?: string | null
}
type SetupData = {
  rows: Row[]
  views: QuickView[]
  facets: Facet[]
  summary: string
  any_filter: boolean
  property: string
  code: string
  property_id: string
  applies_count: number
  total: number
  off_count: number
  needs_name: number
  can_activate: boolean
  has_draft: boolean
  copy_from: { code: string; name: string }[]
  register_loaded: boolean
}

const GENERIC = new Set(["tbc", "tba", "housekeeping", "staff", "team", "everyone", "anyone", "na", "n/a", "?", "-"])

export function SetupPage() {
  const { code } = useRouteParams({ strict: false }) as { code?: string }
  const me = useMe()
  const { property } = useProperty()
  if (me.data && !me.data.can["settings.view"]) return <NoPermission />
  const fallback = property?.code ?? me.data?.properties[0]?.code
  const active = (code ?? fallback)?.toUpperCase()
  if (!me.data) return <LoadingRows rows={8} />
  if (!active)
    return (
      <EmptyState title="No properties yet" icon={<ClipboardList className="size-6" />}>
        Add a property first, then come back to choose its checks.
      </EmptyState>
    )
  return <SetupView key={active} code={active} picked={!!code} />
}

function PropertyPicker({ code, name }: { code: string; name: string }) {
  const me = useMe()
  const navigate = useNavigate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1 text-[22px] leading-tight font-semibold tracking-[-0.015em] hover:bg-hover"
          aria-label={`Property: ${name}. Choose another property`}
        >
          {name}
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Set up another property</DropdownMenuLabel>
        {(me.data?.properties ?? []).map((p) => (
          <DropdownMenuItem
            key={p.id}
            onSelect={() => void navigate({ to: "/settings/setup/$code", params: { code: p.code } })}
            className="justify-between"
          >
            <span>{p.name}</span>
            {p.code === code ? (
              <span className="text-xs text-muted-foreground">Showing</span>
            ) : (
              <span className="mono-id text-xs text-subtle">{p.code}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SetupView({ code, picked }: { code: string; picked: boolean }) {
  const me = useMe()
  const qc = useQueryClient()
  const [p, set] = useParams()
  const key = ["setup", code, p.q, p.view, p.area]
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<SetupData>(`/api/setup/${code}`, { q: p.q, view: p.view, area: list(p.area) }),
    placeholderData: (prev) => prev,
  })
  const d = q.data?.code === code ? q.data : undefined
  const assignees = useAssignees(d?.property_id)
  const opts = useLibraryOptions()
  const can = me.data?.can ?? {}
  const canToggle = !!can["register.toggle"]
  const canAssign = !!can.assign
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [switching, setSwitching] = React.useState<Row | null>(null)
  const [freqRow, setFreqRow] = React.useState<Row | null>(null)
  const [copyFrom, setCopyFrom] = React.useState<{ code: string; name: string } | null>(null)

  const refresh = () => void qc.invalidateQueries({ queryKey: ["setup", code] })
  const setErr = (k: string, v: string | null) =>
    setErrors((e) => {
      const n = { ...e }
      if (v) n[k] = v
      else delete n[k]
      return n
    })

  const patch = useMutation({
    mutationFn: (v: {
      ref: string
      field: string
      body: Record<string, unknown>
      done?: string
      undo?: Record<string, unknown>
    }) => api.patch(`/api/register/${v.ref}`, v.body),
    onSuccess: (_r, v) => {
      setErr(`${v.ref}:${v.field}`, null)
      refresh()
      if (v.done)
        toast(v.done, {
          action: v.undo
            ? {
                label: "Undo",
                onClick: () =>
                  void api
                    .patch(`/api/register/${v.ref}`, v.undo)
                    .then(refresh)
                    .catch((e: unknown) => toastError(errMsg(e))),
              }
            : undefined,
        })
    },
    onError: (e, v) => setErr(`${v.ref}:${v.field}`, errMsg(e)),
  })
  const toggle = useMutation({
    mutationFn: (v: { row: Row; applies: boolean; reason?: string }) =>
      api.post<{ ref?: string; id?: string }>(`/api/setup/${code}/toggle`, {
        template_id: v.row.template_id,
        applies: v.applies,
        reason: v.reason ?? null,
      }),
    onSuccess: (_r, v) => {
      setSwitching(null)
      refresh()
      toast(
        v.applies
          ? `Switched on: ${v.row.template}`
          : canToggle
            ? `Switched off: ${v.row.template}`
            : "Sent to the system owner to decide",
      )
    },
    onError: (e) => toastError(errMsg(e)),
  })
  const loadMaster = useMutation({
    mutationFn: () => api.post<{ added: number }>(`/api/setup/${code}/load-master`),
    onSuccess: (r) => {
      refresh()
      toast(`Loaded the master list: ${plural(r.added, "template")}. Now choose who does each one.`)
    },
    onError: (e) => toastError(errMsg(e)),
  })
  const copy = useMutation({
    mutationFn: (from: string) => api.post<{ copied: number }>(`/api/setup/${code}/copy`, { from_code: from }),
    onSuccess: (r, from) => {
      setCopyFrom(null)
      refresh()
      toast(`Copied ${plural(r.copied, "template")} from ${d?.copy_from.find((c) => c.code === from)?.name ?? from}.`)
    },
    onError: (e) => toastError(errMsg(e)),
  })
  const activate = useMutation({
    mutationFn: () => api.post<{ activated: number }>(`/api/setup/${code}/activate`),
    onSuccess: (r) => {
      refresh()
      toast(`Activated ${plural(r.activated, "check")}. Tasks start appearing in Today lists.`)
    },
    onError: (e) => toastError(errMsg(e)),
  })

  if (q.error instanceof ApiError && q.error.status === 403) return <NoPermission />
  if (q.error && !d) return <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
  if (!d)
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Property setup"
          subtitle="Turn on the checks that apply here, then choose who does each one."
        />
        <LoadingRows rows={10} />
      </div>
    )

  const view = p.view ?? "all"
  const pickFor = (row: Row, field: "done_by" | "accountable" | "cover" | "verifier", o: Opt) => {
    if (!row.ref) return
    const prev = (
      {
        done_by:
          row.done_by_id && row.done_by_kind ? { done_by_kind: row.done_by_kind, done_by_id: row.done_by_id } : null,
        accountable: row.accountable_id ? { accountable_id: row.accountable_id } : null,
        cover: row.cover_id ? { cover_id: row.cover_id } : { clear: ["cover_id"] },
        verifier: row.verifier_id
          ? { verifier_id: row.verifier_id }
          : row.verifier_mode
            ? { verifier_mode: row.verifier_mode, clear: ["verifier_id"] }
            : null,
      } as Record<string, Record<string, unknown> | null>
    )[field]
    let body: Record<string, unknown>
    let done: string
    if (field === "done_by") {
      body = { done_by_kind: o.kind, done_by_id: o.id }
      done = `${row.ref} is now done by ${o.label}`
    } else if (field === "accountable") {
      body = { accountable_id: o.id }
      done = `${o.label} is accountable for ${row.ref}`
    } else if (field === "cover") {
      body = o.kind === "clear" ? { clear: ["cover_id"] } : { cover_id: o.id }
      done = o.kind === "clear" ? `${row.ref} has no cover now` : `${o.label} covers ${row.ref}`
    } else {
      body = o.kind === "mode" ? { verifier_mode: o.id, clear: ["verifier_id"] } : { verifier_id: o.id }
      done = `${row.ref} verifier: ${o.label}`
    }
    patch.mutate({ ref: row.ref, field, body, done, undo: prev ?? undefined })
  }
  const freeText = (row: Row, field: "done_by" | "accountable" | "cover" | "verifier", text: string) => {
    if (!row.ref) return
    const what = { done_by: "Done by", accountable: "Accountable", cover: "Cover", verifier: "Verifier" }[field]
    if (field === "done_by") {
      // The server applies golden rule 2 and says why a generic name is refused.
      api
        .patch(`/api/register/${row.ref}`, { done_by_text: text })
        .then(() => setErr(`${row.ref}:${field}`, `No one called “${text}”. Choose a person, pool or contractor.`))
        .catch((e: unknown) => setErr(`${row.ref}:${field}`, errMsg(e)))
      return
    }
    setErr(
      `${row.ref}:${field}`,
      GENERIC.has(text.toLowerCase())
        ? `"${text}" is not a name. Choose a person for ${what}.`
        : `No one called “${text}”. Choose someone from the list.`,
    )
  }

  const people = assignees.person
  const verifierModes: Opt[] = [
    { kind: "mode", id: "always", label: "Always verify" },
    { kind: "mode", id: "sample", label: "Spot-check" },
    { kind: "mode", id: "none", label: "None" },
  ]

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            Property setup ·
            <PropertyPicker code={d.code} name={d.property} />
          </span>
        }
        subtitle={
          picked ? (
            "Turn on the checks that apply here, then choose who does each one."
          ) : (
            <>
              Turn on the checks that apply here, then choose who does each one. Showing the property you have selected.
            </>
          )
        }
        actions={
          d.register_loaded &&
          canToggle && (
            <>
              {d.copy_from.length > 0 &&
                (d.copy_from.length === 1 ? (
                  <Button variant="outline" onClick={() => setCopyFrom(d.copy_from[0]!)}>
                    Copy setup from {d.copy_from[0]!.name}
                  </Button>
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline">
                        Copy setup from… <ChevronDown />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {d.copy_from.map((c) => (
                        <DropdownMenuItem key={c.code} onSelect={() => setCopyFrom(c)}>
                          {c.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ))}
              {d.has_draft ? (
                <Button
                  disabled={!d.can_activate || activate.isPending}
                  title={d.can_activate ? undefined : "Activation unlocks when every row has a real name"}
                  onClick={() => activate.mutate()}
                >
                  {activate.isPending ? "Activating…" : `Activate ${plural(d.applies_count, "item")}`}
                </Button>
              ) : (
                <Pill tone="green" dot title="Every switched-on check is live">
                  Live · {plural(d.applies_count, "check")} running
                </Pill>
              )}
            </>
          )
        }
      />

      {!d.register_loaded ? (
        <div className="rounded-[10px] border border-divider bg-surface">
          <EmptyState
            icon={<ClipboardList className="size-7" />}
            title={`${d.property} has no register yet`}
            action={
              canToggle && (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button disabled={loadMaster.isPending} onClick={() => loadMaster.mutate()}>
                    {loadMaster.isPending ? "Loading…" : "Load master list"}
                  </Button>
                  <Button variant="outline" asChild>
                    <Link to="/settings/import">Import the Sheet</Link>
                  </Button>
                  {d.copy_from.map((c) => (
                    <Button key={c.code} variant="outline" onClick={() => setCopyFrom(c)}>
                      Copy setup from {c.name}
                    </Button>
                  ))}
                </div>
              )
            }
          >
            Load the master list, or import the Sheet. The master list proposes every template whose rules match this
            property; nothing goes live until you activate it.
          </EmptyState>
        </div>
      ) : (
        <>
          {d.needs_name > 0 && (
            <Callout tone="red" icon={<AlertTriangle className="size-4" aria-hidden />} className="items-center">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="min-w-0 flex-1">
                  <strong>{d.needs_name === 1 ? "1 item still says" : `${d.needs_name} items still say`} "TBC".</strong>{" "}
                  A task with no owner does not get done (golden rule 2).
                  {d.has_draft
                    ? " Activation unlocks when every row has a real name."
                    : " Until then nobody is reminded when it is due."}
                </span>
                {view !== "needs_name" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-st-red/40 bg-surface text-st-red hover:bg-st-red-bg"
                    onClick={() => set({ view: "needs_name" })}
                  >
                    Show only these
                  </Button>
                )}
              </div>
            </Callout>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <SearchBox value={p.q ?? ""} onChange={(v) => set({ q: v || undefined })} placeholder="Search templates" />
            <QuickViews views={d.views} onPick={(k) => set({ view: k === "all" ? undefined : k })} />
            {d.facets.map((f) => (
              <FacetButton key={f.key} facet={f} onChange={(v) => set({ [f.key]: v.join(",") || undefined })} />
            ))}
            {d.any_filter && (
              <button
                type="button"
                onClick={() => set({ q: undefined, view: undefined, area: undefined })}
                className="h-8 rounded-md px-2 text-[13px] text-link hover:bg-hover"
              >
                Clear all filters
              </button>
            )}
          </div>
          <p aria-live="polite" className="m-0 -mt-1 text-right text-[12.5px] text-muted-foreground">
            {d.applies_count} of {d.total} templates apply · {d.off_count} switched off with a reason
            {d.any_filter ? ` · ${d.summary.replace(/\.$/, "").toLowerCase()}` : ""}
          </p>
          <div className="overflow-x-auto rounded-[10px] border border-divider bg-surface">
            <table className="w-full min-w-[1120px] border-collapse text-[13.5px]">
              <caption className="sr-only">Checks at {d.property} and who does each one</caption>
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  {[
                    "Applies",
                    "ID",
                    "Template",
                    "Frequency",
                    "Done by",
                    "Accountable",
                    "Cover",
                    "Verifier",
                    "Setup",
                  ].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="h-[34px] border-b border-divider bg-background px-2 font-medium first:pl-3"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.rows.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <EmptyState title="Nothing here">
                        {view === "needs_name"
                          ? "Every switched-on check has a real name."
                          : "Try a different search or view."}
                      </EmptyState>
                    </td>
                  </tr>
                )}
                {d.rows.map((r) => {
                  const off = r.setup === "off" || r.setup === "off_requested" || r.setup === "not_added"
                  const editable = canAssign && !!r.ref && !off
                  const e = (f: string) => (r.ref ? errors[`${r.ref}:${f}`] : undefined)
                  return (
                    <tr
                      key={r.template_id}
                      className={cn("border-b border-divider last:border-0", off && "bg-background/60")}
                    >
                      <td className="w-[70px] py-2 pl-3">
                        <Switch
                          aria-label={`Applies: ${r.template}`}
                          checked={r.applies && r.setup !== "off_requested" ? true : r.applies}
                          disabled={
                            toggle.isPending ||
                            r.setup === "off_requested" ||
                            (!canToggle && !(can["register.request_toggle"] && r.applies && !!r.ref))
                          }
                          onCheckedChange={(v) => (v ? toggle.mutate({ row: r, applies: true }) : setSwitching(r))}
                        />
                      </td>
                      <td className="mono-id w-[72px] px-2 text-xs whitespace-nowrap text-muted-foreground">
                        {r.ref ?? "—"}
                      </td>
                      <td className="max-w-[270px] px-2">
                        <span className="flex items-center gap-2">
                          <ClassBadge klass={r.class} />
                          <span className={cn("truncate", off && "text-muted-foreground")} title={r.template}>
                            {r.template}
                          </span>
                        </span>
                      </td>
                      {off ? (
                        <>
                          <td colSpan={5} className="px-2 text-[13px] text-muted-foreground">
                            {r.setup === "off_requested" && r.switch_off_request ? (
                              <span className="flex items-center gap-2">
                                <Pill tone="amber">Switch-off requested</Pill>
                                <span className="truncate">
                                  “{r.switch_off_request.reason}”
                                  {r.switch_off_request.by ? ` · ${r.switch_off_request.by}` : ""} · awaiting system
                                  owner
                                </span>
                              </span>
                            ) : r.setup === "not_added" ? (
                              r.proposed ? (
                                "Not added yet · its rules match this property"
                              ) : (
                                "Not added · its rules don't match this property"
                              )
                            ) : (
                              <>Switched off{r.off_reason ? ` · “${r.off_reason}”` : ""}</>
                            )}
                          </td>
                          <td className="px-2 pr-3">
                            {r.setup === "off_requested" && can["approval.decide"] ? (
                              <Button variant="outline" size="sm" asChild>
                                <Link to="/approvals" search={{ kind: "switch_off" }}>
                                  Review
                                </Link>
                              </Button>
                            ) : (
                              <SetupPill row={r} />
                            )}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="w-[120px] px-2">
                            <button
                              type="button"
                              disabled={!editable}
                              onClick={() => setFreqRow(r)}
                              className="rounded px-1 py-0.5 text-left hover:bg-hover disabled:hover:bg-transparent"
                              title={r.frequency_reason ? `Set by: ${r.frequency_reason}` : "Change how often"}
                            >
                              <span className="block whitespace-nowrap">{r.frequency_label}</span>
                              {r.frequency_default && (
                                <span className="block text-[11.5px] text-muted-foreground">
                                  Default {r.frequency_default}
                                </span>
                              )}
                            </button>
                          </td>
                          <td className="w-[190px] px-1 py-1.5">
                            <AssigneePicker
                              label={`Done by for ${r.ref}`}
                              value={r.done_by}
                              invalid={r.done_by === "TBC"}
                              disabled={!editable}
                              selected={
                                r.done_by_kind && r.done_by_id ? { kind: r.done_by_kind, id: r.done_by_id } : null
                              }
                              badge={
                                r.done_by_kind === "contractor" ? (
                                  <Pill tone="grey" className="h-[18px] px-1.5 text-[11px]">
                                    Contractor
                                  </Pill>
                                ) : undefined
                              }
                              options={[
                                { kind: "pool", items: assignees.pool },
                                { kind: "person", items: people },
                                { kind: "contractor", items: assignees.contractor },
                              ]}
                              footnote={<>"TBC" and "Housekeeping" are not accepted. Golden rule 2.</>}
                              error={e("done_by")}
                              onPick={(o) => pickFor(r, "done_by", o)}
                              onFreeText={(t) => freeText(r, "done_by", t)}
                            />
                          </td>
                          <td className="w-[160px] px-1 py-1.5">
                            <AssigneePicker
                              label={`Accountable for ${r.ref}`}
                              value={r.accountable}
                              invalid={r.accountable === "TBC"}
                              disabled={!editable}
                              selected={r.accountable_id ? { kind: "person", id: r.accountable_id } : null}
                              options={[{ kind: "person", items: people }]}
                              footnote="Only people can be accountable, not pools."
                              error={e("accountable")}
                              onPick={(o) => pickFor(r, "accountable", o)}
                              onFreeText={(t) => freeText(r, "accountable", t)}
                            />
                          </td>
                          <td className="w-[160px] px-1 py-1.5">
                            <AssigneePicker
                              label={`Cover for ${r.ref}`}
                              value={r.cover ?? "Add cover"}
                              disabled={!editable}
                              selected={r.cover_id ? { kind: "person", id: r.cover_id } : null}
                              options={[
                                ...(r.cover_id
                                  ? [
                                      {
                                        kind: "clear" as const,
                                        items: [{ kind: "clear" as const, id: "none", label: "No cover" }],
                                      },
                                    ]
                                  : []),
                                { kind: "person", items: people },
                              ]}
                              footnote="Cover does the check when the person named is away."
                              error={e("cover")}
                              onPick={(o) => pickFor(r, "cover", o)}
                              onFreeText={(t) => freeText(r, "cover", t)}
                            />
                          </td>
                          <td className="w-[150px] px-1 py-1.5">
                            <AssigneePicker
                              label={`Verifier for ${r.ref}`}
                              value={r.verifier ?? "Spot-check"}
                              disabled={!editable}
                              selected={
                                r.verifier_id
                                  ? { kind: "person", id: r.verifier_id }
                                  : r.verifier_mode
                                    ? { kind: "mode", id: r.verifier_mode }
                                    : null
                              }
                              options={[
                                { kind: "mode", items: verifierModes },
                                { kind: "person", items: people },
                              ]}
                              footnote="Always verify, a spot-check, none, or a named person."
                              error={e("verifier")}
                              onPick={(o) => pickFor(r, "verifier", o)}
                              onFreeText={(t) => freeText(r, "verifier", t)}
                            />
                          </td>
                          <td className="px-2 pr-3">
                            <SetupPill row={r} />
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="m-0 text-[12.5px] text-muted-foreground">
            A frequency override needs the FRA section or assessor decision that set it (CMS-12). Switching a template
            off needs a reason{canToggle ? "" : " and system owner approval"}.
          </p>
        </>
      )}

      {switching && (
        <SwitchOffDialog
          row={switching}
          request={!canToggle}
          busy={toggle.isPending}
          onClose={() => setSwitching(null)}
          onConfirm={(reason) => toggle.mutate({ row: switching, applies: false, reason })}
        />
      )}
      {freqRow && (
        <FrequencyDialog
          row={freqRow}
          frequencies={opts.data?.frequencies ?? []}
          onClose={() => setFreqRow(null)}
          onSaved={() => {
            setFreqRow(null)
            refresh()
          }}
        />
      )}
      {copyFrom && (
        <ActionDialog
          open
          onOpenChange={(o) => !o && setCopyFrom(null)}
          busy={copy.isPending}
          title={`Copy the setup from ${copyFrom.name}?`}
          subtitle={`Into ${d.property}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setCopyFrom(null)}>
                Cancel
              </Button>
              <Button disabled={copy.isPending} onClick={() => copy.mutate(copyFrom.code)}>
                {copy.isPending ? "Copying…" : "Copy setup"}
              </Button>
            </>
          }
        >
          <p className="m-0">This copies which checks apply, how often, verification and who is accountable.</p>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            <li>Groups and contractors carry over where {d.property} has one of the same kind</li>
            <li>People named only at {copyFrom.name} are left for you to fill in</li>
            <li>Only rows still in draft here change; live checks keep their setup</li>
          </ul>
        </ActionDialog>
      )}
    </div>
  )
}

function SetupPill({ row: r }: { row: Row }) {
  if (r.setup === "ready")
    return (
      <Pill tone="green" dot>
        {r.state === "draft" ? "Ready · draft" : "Ready"}
      </Pill>
    )
  if (r.setup === "needs_owner")
    return (
      <Pill tone="red" dot>
        Needs owner
      </Pill>
    )
  if (r.setup === "off_requested") return <Pill tone="amber">Requested</Pill>
  if (r.setup === "not_added") return <Pill tone="outline">Not added</Pill>
  return <Pill tone="grey">Off</Pill>
}

function SwitchOffDialog({
  row,
  request,
  busy,
  onClose,
  onConfirm,
}: {
  row: Row
  request: boolean
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = React.useState("")
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={busy}
      title={request ? "Ask to switch this check off?" : "Switch this check off?"}
      subtitle={`${row.template}${row.ref ? ` · ${row.ref}` : ""}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!reason.trim() || busy} onClick={() => onConfirm(reason.trim())}>
            {busy ? "Sending…" : request ? "Ask the system owner" : "Switch off"}
          </Button>
        </>
      }
    >
      <p className="m-0">
        {request
          ? "The system owner decides. Until then the check keeps running and stays on Today lists."
          : "No new tasks are made for it here. Past records stay, and you can switch it back on later."}
      </p>
      {row.class === "A" && (
        <Callout tone="amber">This is a life-safety (Class A) check. Say exactly why it doesn't apply here.</Callout>
      )}
      <Labeled label="Reason" htmlFor="off-reason">
        <TextInput
          id="off-reason"
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. No CCTV fitted"
        />
      </Labeled>
    </ActionDialog>
  )
}

function FrequencyDialog({
  row,
  frequencies,
  onClose,
  onSaved,
}: {
  row: Row
  frequencies: { key: string; label: string }[]
  onClose: () => void
  onSaved: () => void
}) {
  const [freq, setFreq] = React.useState(row.frequency)
  const [reason, setReason] = React.useState(row.frequency_reason ?? "")
  const [error, setError] = React.useState<string | null>(null)
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/register/${row.ref}`, body),
    onSuccess: () => {
      toast(`${row.ref} now runs ${frequencies.find((f) => f.key === freq)?.label.toLowerCase() ?? freq}`)
      onSaved()
    },
    onError: (e) => setError(errMsg(e)),
  })
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={m.isPending}
      title="Change how often"
      subtitle={`${row.template} · ${row.ref}`}
      footer={
        <>
          {row.frequency_default && (
            <Button
              variant="ghost"
              className="mr-auto"
              disabled={m.isPending}
              onClick={() => m.mutate({ clear: ["frequency"] })}
            >
              Back to default ({row.frequency_default})
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!reason.trim() || m.isPending || freq === row.frequency}
            onClick={() => m.mutate({ frequency: freq, frequency_reason: reason.trim() })}
          >
            {m.isPending ? "Saving…" : "Change frequency"}
          </Button>
        </>
      }
    >
      <Labeled label="How often" htmlFor="fq">
        <NativeSelect
          id="fq"
          value={freq}
          onChange={(e) => setFreq(e.target.value)}
          options={frequencies.map((f) => ({ value: f.key, label: f.label }))}
        />
      </Labeled>
      <Labeled
        label="FRA section or assessor decision that set it"
        htmlFor="fq-reason"
        error={error}
        hint="Required (CMS-12). Future tasks follow the new frequency; past records don't change."
      >
        <TextInput
          id="fq-reason"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value)
            setError(null)
          }}
          placeholder="e.g. FRA 2026 §4.2: monthly while the hot tub is in use"
        />
      </Labeled>
    </ActionDialog>
  )
}
