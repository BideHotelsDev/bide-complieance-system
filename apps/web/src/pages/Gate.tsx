/*
 * One property's opening checklist (design: Gate.dc.html). Key numbers, sections A–H with progress (click to pick
 * one), the H08 dutyholder sign-off (unlocks only at Ready to open), and the items in the chosen section. "Mark items"
 * switches the table into edit mode: change status inline or open an item to add evidence, owner and notes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useParams as useRouteParams } from "@tanstack/react-router"
import * as React from "react"
import { AlertTriangle, Clock, PenLine } from "lucide-react"

import { api, type ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { ErrorState, LoadingPage, Skeleton } from "@bide-comply/ui/components/page"
import { ClassBadge, GateBadge, GateItemBadge, Pill } from "@bide-comply/ui/components/status"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { GATE_STATUSES, GateItemDialog, saveItem } from "@/features/queues/gate-item"
import type { GateDetail, GateItem } from "@/features/queues/types"
import { IconBox, Legend, Progress, QDialog, Ring, StatBig, StatCard, StatTitle } from "@/features/queues/ui"
import { fmtDateTime } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useMe } from "@/lib/session"

export function GatePage() {
  const { code } = useRouteParams({ strict: false }) as { code?: string }
  const [params, set] = useParams()
  const qc = useQueryClient()
  const res = useQuery<GateDetail, ApiError>({
    queryKey: ["gate", code],
    queryFn: () => api.get<GateDetail>(`/api/gates/${code}`),
    enabled: !!code,
  })
  const [editing, setEditing] = React.useState<GateItem | null>(null)
  const [signing, setSigning] = React.useState(false)
  const g = res.data
  const edit = params.edit === "1" && !!g?.can_edit
  const section = params.section ?? g?.selected_section ?? "A"
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["gate", code] })
    void qc.invalidateQueries({ queryKey: ["gates"] })
  }

  const quick = useMutation({
    mutationFn: ({ item, status }: { item: GateItem; status: string }) => saveItem(item.id, { status }),
    onSuccess: (r, { item, status }) => {
      if (status === "done" && r.status === "to_confirm") toast(`${item.ref} stays To confirm until its evidence is attached`)
      else toast(`${item.ref} marked ${GATE_STATUSES.find((s) => s.value === r.status)?.label ?? r.status}`)
      refresh()
    },
    onError: (e: ApiError) => toastError(e.message),
  })

  if (res.error)
    return (
      <div className="rounded-[10px] border border-divider bg-surface">
        <ErrorState
          title={res.error.status === 404 ? "No opening checklist here" : undefined}
          message={res.error.status === 404 ? res.error.message : undefined}
          onRetry={res.error.status === 404 ? undefined : () => void res.refetch()}
        />
      </div>
    )
  if (!g) return <LoadingPage />

  const s = g.summary
  const sec = g.sections.find((x) => x.key === section) ?? g.sections[0]
  const items = g.items.filter((i) => i.section === sec?.key)
  const counts = (["in_progress", "to_confirm", "not_started", "done", "na"] as const)
    .map((k) => ({ k, n: items.filter((i) => i.status === k).length }))
    .filter((c) => c.n > 0)
  const signerShort = (g.dutyholder ?? "dutyholder").split(" ")[0]

  return (
    <div className="flex max-w-[1240px] flex-col gap-4">
      <nav aria-label="Breadcrumb" className="text-[12px] text-muted-foreground">
        <Link to="/gates" className="text-muted-foreground no-underline hover:text-foreground">
          Opening checklists
        </Link>{" "}
        / <span className="text-foreground">{g.property}</span>
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 text-[20px] font-semibold">{g.property} · Opening checklist</h1>
            <GateBadge status={g.status} />
          </div>
          <p className="m-0 mt-1 text-muted-foreground">{g.subtitle}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to="/reports" search={{ property: g.property_id, pack: "gate" }}>
              Export gate pack
            </Link>
          </Button>
          {g.can_edit && (
            <Button variant={edit ? "outline" : "default"} aria-pressed={edit} onClick={() => set({ edit: edit ? undefined : "1" })}>
              {edit ? "Done marking" : "Mark items"}
            </Button>
          )}
        </div>
      </header>

      <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard>
          <Ring
            segments={[{ label: "Done", value: s.done, color: "var(--c-foreground)" }]}
            total={s.applicable}
            stroke={9}
            center={`${s.done}/${s.applicable}`}
            label={`${s.done} of ${s.applicable} done`}
          />
          <div className="min-w-0">
            <StatTitle>Checklist done</StatTitle>
            <div className="mt-1.5 text-[12.5px] text-muted-foreground">Every life-safety item must be done to open</div>
          </div>
        </StatCard>
        <StatCard>
          <IconBox tone={s.class_a_open ? "red" : "green"}>
            <AlertTriangle className="size-5" />
          </IconBox>
          <div className="min-w-0 flex-1">
            <StatTitle>Life-safety items open</StatTitle>
            <StatBig value={s.class_a_open} sub={s.class_a_open ? "act now" : "all done"} />
          </div>
        </StatCard>
        <StatCard>
          <IconBox tone="amber">
            <Clock className="size-5" />
          </IconBox>
          <div className="min-w-0 flex-1">
            <StatTitle>Waiting for proof</StatTitle>
            <StatBig value={s.to_confirm} sub="to confirm" />
          </div>
        </StatCard>
        <Link to="/actions" search={{ prop: g.code }} className="text-foreground no-underline">
          <StatCard className="h-full hover:border-border">
            <Ring
              segments={[
                { label: "Urgent", value: s.actions_urgent, color: "var(--c-foreground)" },
                { label: "Other", value: s.actions_other, color: "var(--c-border)" },
              ]}
              center={s.actions_urgent + s.actions_other}
              label={`${s.actions_urgent + s.actions_other} Actions open: ${s.actions_urgent} urgent, ${s.actions_other} other`}
            />
            <div className="min-w-0 flex-1">
              <StatTitle>Actions open</StatTitle>
              <Legend
                items={[
                  { label: "Urgent", value: s.actions_urgent, color: "var(--c-foreground)" },
                  { label: "Other", value: s.actions_other, color: "var(--c-border)" },
                ]}
              />
            </div>
          </StatCard>
        </Link>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <section aria-label="Sections" className="min-w-0 flex-[1_1_420px] overflow-hidden rounded-[10px] border border-divider bg-surface">
          <div className="grid grid-cols-[28px_1fr_90px_70px_140px] gap-2.5 border-b border-divider px-3.5 py-2 text-[12px] font-medium text-muted-foreground max-sm:grid-cols-[28px_1fr_70px_60px]">
            <span />
            <span>Section</span>
            <span>Done</span>
            <span>A open</span>
            <span className="max-sm:hidden">Progress</span>
          </div>
          <div role="listbox" aria-label="Pick a section">
            {g.sections.map((x) => {
              const on = x.key === sec?.key
              return (
                <button
                  key={x.key}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => set({ section: x.key })}
                  className={cn(
                    "grid w-full grid-cols-[28px_1fr_90px_70px_140px] items-center gap-2.5 border-b border-divider px-3.5 py-2.5 text-left last:border-b-0 hover:bg-hover/50 max-sm:grid-cols-[28px_1fr_70px_60px]",
                    on && "bg-st-blue-bg/60 shadow-[inset_3px_0_0_var(--c-blue)] hover:bg-st-blue-bg/60",
                  )}
                >
                  <span className="font-mono text-[12px] text-muted-foreground">{x.key}</span>
                  <span className={cn(on && "font-medium")}>{x.name}</span>
                  <span className="tabular">
                    {x.done} of {x.total}
                  </span>
                  <span className={cn("tabular", x.a_open ? "font-semibold text-st-red" : "text-muted-foreground")}>{x.a_open}</span>
                  <Progress value={x.done} total={x.total} className="max-sm:hidden" />
                </button>
              )
            })}
          </div>
        </section>

        <section aria-label="Gate sign-off" className="flex flex-[1_1_300px] flex-col gap-3 rounded-[10px] border border-divider bg-surface p-4">
          <div className="flex items-center gap-2">
            <PenLine aria-hidden className="size-4" />
            <span className="font-semibold">H08 · Gate sign-off</span>
            <ClassBadge klass="A" className="ml-auto" />
          </div>
          <p className="m-0">The dutyholder confirms every applicable life-safety item is Done with evidence.</p>
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[12px]">
              <span className="text-muted-foreground">Life-safety items done</span>
              <span className="tabular font-semibold">
                {g.signoff.class_a_done} of {g.signoff.class_a_applicable}
              </span>
            </div>
            <Progress value={g.signoff.class_a_done} total={g.signoff.class_a_applicable} height={8} />
          </div>
          {g.signoff.signed ? (
            <Pill tone="green" className="self-start">
              Signed by {g.signoff.signed.by} · {fmtDateTime(g.signoff.signed.at)}
            </Pill>
          ) : (
            <Button className="justify-center" disabled={!g.signoff.can_sign} onClick={() => setSigning(true)}>
              Sign as {signerShort} director
            </Button>
          )}
          <p className="m-0 text-[12px] text-muted-foreground">
            {g.signoff.unlocked
              ? `Ready to open. Signer: ${g.signoff.signer}.`
              : `Unlocks only when the gate shows Ready to open (GATE-04). Signer: ${g.signoff.signer}.`}
          </p>
        </section>
      </div>

      {sec && (
        <section aria-labelledby={`sec-${sec.key}`} className="overflow-hidden rounded-[10px] border border-divider bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider px-3.5 py-3">
            <h2 id={`sec-${sec.key}`} className="m-0 text-[14px] font-semibold">
              {sec.key} · {sec.name} <span className="font-normal text-muted-foreground">{items.length} items</span>
            </h2>
            <span className="flex flex-wrap gap-1.5">
              {counts.map((c) => (
                <GateCount key={c.k} k={c.k} n={c.n} />
              ))}
            </span>
          </div>
          {edit && (
            <div className="border-b border-divider bg-st-blue-bg px-3.5 py-2 text-[13px] text-st-blue">
              Marking items. Change a status here, or open an item to add evidence, an owner and notes. Done needs evidence, otherwise it
              stays To confirm.
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse">
              <caption className="sr-only">
                Section {sec.key} items
              </caption>
              <thead>
                <tr>
                  {["Ref", "Item", "Class", "Evidence required", "Status", "Notes", ...(edit ? [""] : [])].map((h, i) => (
                    <th
                      key={i}
                      scope="col"
                      className="h-[34px] border-b border-divider bg-background px-2.5 text-left text-[12px] font-medium whitespace-nowrap text-muted-foreground"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr
                    key={i.id}
                    className={cn("border-b border-divider last:border-0", g.can_edit && "cursor-pointer hover:bg-hover/50")}
                    onClick={g.can_edit ? () => setEditing(i) : undefined}
                  >
                    <td className="px-2.5 py-2 align-middle font-mono text-[11.5px] text-subtle">{i.ref}</td>
                    <td className={cn("px-2.5 py-2 align-middle text-[13.5px]", (i.wording_pending || !i.applies) && "text-muted-foreground")}>
                      <span className={cn(!i.applies && "line-through")}>{i.item}</span>
                      {i.wording_pending && <span className="block text-[12px] text-subtle">Wording pending</span>}
                      {i.actions > 0 && (
                        <Link
                          to="/actions"
                          search={{ prop: g.code, gate: i.ref }}
                          onClick={(e) => e.stopPropagation()}
                          className="block text-[12px] text-link"
                        >
                          {i.actions} {i.actions === 1 ? "Action" : "Actions"} open
                        </Link>
                      )}
                    </td>
                    <td className="px-2.5 py-2 align-middle">
                      <ClassBadge klass={i.class} />
                    </td>
                    <td className="px-2.5 py-2 align-middle text-[13px] text-muted-foreground">
                      {i.evidence_required ?? "—"}
                      {(i.evidence.length > 0 || i.evidence_link) && (
                        <span className="block text-[12px] text-st-green">
                          {i.evidence.length > 0 ? `${i.evidence.length} ${i.evidence.length === 1 ? "file" : "files"} filed` : `Filed: ${i.evidence_link}`}
                        </span>
                      )}
                    </td>
                    <td className="px-2.5 py-2 align-middle" onClick={edit ? (e) => e.stopPropagation() : undefined}>
                      {edit && i.ref !== "H08" ? (
                        <select
                          aria-label={`Status of ${i.ref}`}
                          value={i.status}
                          disabled={quick.isPending}
                          onChange={(e) => {
                            if (e.target.value === "na" && !i.na_reason) setEditing({ ...i, status: "na" })
                            else quick.mutate({ item: i, status: e.target.value })
                          }}
                          className="h-7 rounded-md border border-border bg-surface px-1.5 text-[12.5px]"
                        >
                          {GATE_STATUSES.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label.replace(" (doesn't apply here)", "")}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="flex flex-col items-start gap-0.5">
                          <GateItemBadge status={i.status} />
                          {i.done_without_evidence && <span className="text-[11.5px] text-st-amber">No evidence filed</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-2.5 py-2 align-middle text-[13px] text-muted-foreground">
                      {!i.applies && i.na_reason ? `N/A: ${i.na_reason}` : i.notes || "—"}
                      {i.owner && <span className="block text-[12px] text-subtle">Owner: {i.owner}</span>}
                    </td>
                    {edit && (
                      <td className="px-2.5 py-2 align-middle">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditing(i)
                          }}
                        >
                          Edit
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editing && <GateItemDialog item={editing} propertyId={g.property_id} onDone={() => setEditing(null)} onSaved={refresh} />}
      {signing && <SignGateDialog g={g} onDone={() => setSigning(false)} onSigned={refresh} />}
    </div>
  )
}

function GateCount({ k, n }: { k: string; n: number }) {
  const label = { in_progress: "In progress", to_confirm: "To confirm", not_started: "Not started", done: "Done", na: "N/A" }[k]
  const tone = ({ in_progress: "blue", to_confirm: "amber", not_started: "outline", done: "green", na: "grey" } as const)[k as "done"]
  return (
    <Pill tone={tone}>
      {label} {n}
    </Pill>
  )
}

function SignGateDialog({ g, onDone, onSigned }: { g: GateDetail; onDone: () => void; onSigned: () => void }) {
  const me = useMe()
  const [confirm, setConfirm] = React.useState(false)
  const [name, setName] = React.useState("")
  const sign = useMutation({
    mutationFn: () => api.post(`/api/gates/${g.code}/sign`, { confirm, full_name: name.trim() }),
    onSuccess: () => {
      toast("Opening checklist signed")
      onSigned()
      onDone()
    },
    onError: (e: ApiError) => toastError(e.message),
  })
  if (!me.data) return <Skeleton className="h-4" />
  return (
    <QDialog
      open
      onOpenChange={(o) => !o && onDone()}
      busy={sign.isPending}
      title={`Sign the opening checklist for ${g.property}?`}
      sub={`H08 · ${g.signoff.class_a_done} of ${g.signoff.class_a_applicable} life-safety items done`}
      footer={
        <>
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button disabled={!confirm || name.trim().length < 3 || sign.isPending} onClick={() => sign.mutate()}>
            {sign.isPending ? "Signing…" : `Sign as ${g.dutyholder ?? "dutyholder"}`}
          </Button>
        </>
      }
    >
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--c-primary)]" />
        <span>
          I confirm every applicable life-safety item on the opening checklist for {g.property} is done with evidence. I sign on behalf of{" "}
          {g.dutyholder ?? "the dutyholder"}.
        </span>
      </label>
      <label className="flex flex-col gap-[5px]">
        <span className="text-[12px] font-medium text-ink2">Type your full name to sign</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          className="h-9 rounded-md border border-border bg-surface px-2.5 text-[15px] outline-none focus-visible:outline-2 focus-visible:outline-focus"
        />
      </label>
      <span className="text-[12px] text-muted-foreground">
        Recorded with your name, the time and a fingerprint of the checklist as it stands (SGN-01).
      </span>
    </QDialog>
  )
}
