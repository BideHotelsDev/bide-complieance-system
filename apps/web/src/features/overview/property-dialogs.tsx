/*
 * Dialogs on the One property screen: Raise an Action, Reassign (golden rule: one name per item), Upload new
 * certificate, and Switch off / Pause (someone else approves). Each main button is named after its action.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"

import { api, ApiError, upload } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bide-comply/ui/components/dialog"
import { Input } from "@bide-comply/ui/components/input"
import { Label } from "@bide-comply/ui/components/label"
import { Callout } from "@bide-comply/ui/components/page"
import { Textarea } from "@bide-comply/ui/components/textarea"
import { toast } from "@bide-comply/ui/components/toaster"

import type { AssignOptions, Option, RegisterDetail } from "./property-types"

const selectCls =
  "h-9 w-full rounded-md border border-input bg-surface px-2.5 text-[13.5px] outline-none focus-visible:outline-2 focus-visible:outline-focus"

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="m-0 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <Callout tone="red" className="text-[13px]">
      <span role="alert">{error}</span>
    </Callout>
  )
}

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Nothing was saved. Try again.")

/* Raise an Action at this property (optionally from a register item) */
export function RaiseActionDialog({
  open,
  onOpenChange,
  propertyId,
  propertyName,
  item,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  propertyId: string
  propertyName: string
  item?: { ref: string; check: string; class: string } | null
}) {
  const qc = useQueryClient()
  const [description, setDescription] = React.useState("")
  const [type, setType] = React.useState("action")
  const [priority, setPriority] = React.useState("")
  const [klass, setKlass] = React.useState(item?.class ?? "")
  const [dueOn, setDueOn] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (open) {
      setDescription("")
      setType("action")
      setPriority("")
      setKlass(item?.class ?? "")
      setDueOn("")
      setError(null)
    }
  }, [open, item])
  const m = useMutation({
    mutationFn: () =>
      api.post<{ ref: string }>("/api/actions", {
        property_id: propertyId,
        description,
        type,
        priority: priority || null,
        klass: klass || null,
        due_on: dueOn || null,
        source: "manual",
        source_ref: item ? `Check ${item.ref}` : null,
      }),
    onSuccess: (r) => {
      toast(`Action ${r.ref} raised at ${propertyName}`)
      void qc.invalidateQueries({ queryKey: ["property"] })
      void qc.invalidateQueries({ queryKey: ["actions"] })
      onOpenChange(false)
    },
    onError: (e) => setError(msg(e)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Raise an Action</DialogTitle>
          <DialogDescription>
            {item ? `At ${propertyName}, from ${item.ref} ${item.check}.` : `At ${propertyName}.`} It goes on the
            Actions to fix list straight away.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            if (!description.trim()) return setError("Say what needs fixing.")
            m.mutate()
          }}
        >
          <Field id="ra-desc" label="What needs fixing">
            <Textarea id="ra-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="ra-type" label="Type">
              <select id="ra-type" className={selectCls} value={type} onChange={(e) => setType(e.target.value)}>
                <option value="action">Action</option>
                <option value="work_required">Work required</option>
                <option value="advisory">Advisory (needs a decision)</option>
              </select>
            </Field>
            <Field id="ra-prio" label="Priority" hint="Urgent 7 days, Soon 30, Later 90.">
              <select id="ra-prio" className={selectCls} value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="">Set from the class</option>
                <option value="high">Urgent</option>
                <option value="med">Soon</option>
                <option value="low">Later</option>
              </select>
            </Field>
            <Field id="ra-class" label="Class">
              <select id="ra-class" className={selectCls} value={klass} onChange={(e) => setKlass(e.target.value)}>
                <option value="">Not set</option>
                <option value="A">A · Life safety</option>
                <option value="B">B · Statutory</option>
                <option value="C">C · bide standard</option>
              </select>
            </Field>
            <Field id="ra-due" label="Due (optional)">
              <Input id="ra-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
            </Field>
          </div>
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={m.isPending}>
              {m.isPending ? "Raising…" : "Raise Action"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* Reassign: Done by is a named person, pool or contractor. "TBC" or "Housekeeping" is refused. */
type DoerChoice = { kind: "person" | "pool" | "contractor"; o: Option }

export function ReassignDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  item: RegisterDetail
}) {
  const qc = useQueryClient()
  const opts = useQuery<AssignOptions, ApiError>({
    queryKey: ["assign-options", item.ref],
    queryFn: () => api.get<AssignOptions>(`/api/register/${item.ref}/assign-options`),
    enabled: open,
  })
  const [doer, setDoer] = React.useState("")
  const [accountable, setAccountable] = React.useState("")
  const [cover, setCover] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (open) {
      setDoer(item.done_by === "Needs a name" || item.done_by === "—" ? "" : item.done_by)
      setAccountable(item.accountable_id ?? "")
      setCover(item.cover_id ?? "")
      setError(null)
    }
  }, [open, item])
  const choices: DoerChoice[] = React.useMemo(() => {
    const d = opts.data
    if (!d) return []
    return [
      ...d.people.map((o) => ({ kind: "person" as const, o })),
      ...d.pools.map((o) => ({ kind: "pool" as const, o })),
      ...d.contractors.map((o) => ({ kind: "contractor" as const, o })),
    ]
  }, [opts.data])
  const m = useMutation({
    mutationFn: async () => {
      const typed = doer.trim()
      const match = choices.find((c) => c.o.name.toLowerCase() === typed.toLowerCase())
      const body: Record<string, unknown> = {}
      if (typed !== item.done_by) {
        if (!match) {
          // Let the server apply the golden rule to what was typed ("TBC", "Housekeeping" are not names).
          await api.patch(`/api/register/${item.ref}`, { done_by_text: typed })
          throw new ApiError(422, "pick", "Pick a person, pool or contractor from the list for Done by.")
        }
        body.done_by_kind = match.kind
        body.done_by_id = match.o.id
        body.done_by_text = typed
      }
      if (accountable && accountable !== item.accountable_id) body.accountable_id = accountable
      if (cover !== (item.cover_id ?? "")) {
        if (cover) body.cover_id = cover
        else body.clear = ["cover_id"]
      }
      return api.patch(`/api/register/${item.ref}`, body)
    },
    onSuccess: () => {
      toast(`${item.ref} reassigned`)
      void qc.invalidateQueries({ queryKey: ["property"] })
      onOpenChange(false)
    },
    onError: (e) => setError(msg(e)),
  })
  const kindWord = { person: "Person", pool: "Pool", contractor: "Contractor" }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign {item.ref}</DialogTitle>
          <DialogDescription>
            {item.check}. One name per item: a person, a pool or a contractor. Future tasks go to the new name.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            m.mutate()
          }}
        >
          <Field id="rs-doer" label="Done by" hint="Type to search people, pools and contractors.">
            <Input
              id="rs-doer"
              list="rs-doer-list"
              value={doer}
              onChange={(e) => setDoer(e.target.value)}
              autoComplete="off"
            />
            <datalist id="rs-doer-list">
              {choices.map((c) => (
                <option key={`${c.kind}-${c.o.id}`} value={c.o.name}>
                  {kindWord[c.kind]}
                  {c.o.sub ? ` · ${c.o.sub}` : ""}
                </option>
              ))}
            </datalist>
          </Field>
          <Field id="rs-acc" label="Accountable" hint="Only people can be accountable, not pools.">
            <select
              id="rs-acc"
              className={selectCls}
              value={accountable}
              onChange={(e) => setAccountable(e.target.value)}
            >
              <option value="">Choose a person</option>
              {opts.data?.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field id="rs-cover" label="Cover when away">
            <select id="rs-cover" className={selectCls} value={cover} onChange={(e) => setCover(e.target.value)}>
              <option value="">No cover</option>
              {opts.data?.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <ErrorLine error={error ?? (opts.error ? opts.error.message : null)} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={m.isPending || !opts.data}>
              {m.isPending ? "Saving…" : "Reassign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* Upload new certificate: file, issue and expiry dates, issuer; each fail listed becomes an Action (DOC-07) */
export function CertificateDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  item: RegisterDetail
}) {
  const qc = useQueryClient()
  const [file, setFile] = React.useState<File | null>(null)
  const [issued, setIssued] = React.useState("")
  const [expires, setExpires] = React.useState("")
  const [issuer, setIssuer] = React.useState("")
  const [fails, setFails] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (open) {
      setFile(null)
      setIssued("")
      setExpires("")
      setIssuer("")
      setFails("")
      setError(null)
    }
  }, [open])
  const m = useMutation({
    mutationFn: async () => {
      const up = await upload(file as File, { captured_with: "upload", property_id: item.property_id })
      return api.post(`/api/register/${item.ref}/certificate`, {
        evidence_id: up.id,
        issued_on: issued,
        expires_on: expires || null,
        issuer: issuer || null,
        fails: fails
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((text) => ({ text })),
      })
    },
    onSuccess: () => {
      const n = fails.split("\n").filter((t) => t.trim()).length
      toast(
        n
          ? `Certificate filed for ${item.ref} · ${n} Action${n === 1 ? "" : "s"} raised from the fails`
          : `Certificate filed for ${item.ref}`,
      )
      void qc.invalidateQueries({ queryKey: ["property"] })
      void qc.invalidateQueries({ queryKey: ["certificates"] })
      onOpenChange(false)
    },
    onError: (e) => setError(msg(e)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload new certificate</DialogTitle>
          <DialogDescription>
            {item.ref} {item.check}. The new certificate replaces the current one; the old one stays in the history.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            if (!file) return setError("Choose the certificate file.")
            if (!issued) return setError("Give the date the certificate was issued.")
            m.mutate()
          }}
        >
          <Field id="cd-file" label="Certificate file" hint="PDF or photo of the certificate.">
            <Input
              id="cd-file"
              type="file"
              accept="application/pdf,image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="cd-issued" label="Issued on">
              <Input id="cd-issued" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} />
            </Field>
            <Field id="cd-expires" label="Expires on">
              <Input id="cd-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </Field>
          </div>
          <Field id="cd-issuer" label="Issued by">
            <Input
              id="cd-issuer"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="Contractor or engineer"
            />
          </Field>
          <Field
            id="cd-fails"
            label="Fails or defects in the report"
            hint="One per line. Each becomes an Action, and the item stays Red until they are closed."
          >
            <Textarea id="cd-fails" rows={3} value={fails} onChange={(e) => setFails(e.target.value)} />
          </Field>
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={m.isPending}>
              {m.isPending ? "Uploading…" : "Upload certificate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* Switch off or pause a check: needs a reason, and someone else approves (SCH-10..12) */
export function RequestDialog({
  open,
  onOpenChange,
  item,
  kind,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  item: RegisterDetail
  kind: "switch_off" | "pause"
}) {
  const qc = useQueryClient()
  const [reason, setReason] = React.useState("")
  const [until, setUntil] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (open) {
      setReason("")
      setUntil("")
      setError(null)
    }
  }, [open])
  const m = useMutation({
    mutationFn: () =>
      api.post(`/api/register/${item.ref}/request`, { kind, reason, until: kind === "pause" && until ? until : null }),
    onSuccess: () => {
      toast(kind === "pause" ? `Pause of ${item.ref} sent for approval` : `Switch-off of ${item.ref} sent for approval`)
      void qc.invalidateQueries({ queryKey: ["property"] })
      onOpenChange(false)
    },
    onError: (e) => setError(msg(e)),
  })
  const title = kind === "pause" ? `Pause ${item.ref}` : `Switch off ${item.ref}`
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {item.check}.{" "}
            {kind === "pause"
              ? "No tasks are made while it's paused. It starts again on the date you give."
              : "The check stops at this property. Use this when it doesn't apply here, for example no hot tub."}{" "}
            Someone else approves it{item.class === "A" ? "; life-safety items need the system owner" : ""}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            if (!reason.trim()) return setError("Give a reason.")
            m.mutate()
          }}
        >
          <Field id="rq-reason" label="Reason">
            <Textarea id="rq-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {kind === "pause" && (
            <Field id="rq-until" label="Paused until">
              <Input id="rq-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
            </Field>
          )}
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={m.isPending}>
              {m.isPending ? "Sending…" : "Send for approval"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
