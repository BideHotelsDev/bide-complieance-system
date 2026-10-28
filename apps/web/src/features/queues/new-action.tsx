/* New Action (design: Actions to fix › New Action). Priority sets the due date unless one is given. */
import { useMutation, useQuery } from "@tanstack/react-query"
import * as React from "react"

import { api, type ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { toast, toastError } from "@bide-comply/ui/components/toaster"

import { useMe } from "@/lib/session"
import type { Person } from "./types"
import { Field, inputCls, QDialog, textareaCls } from "./ui"

export function NewActionDialog({
  open,
  onOpenChange,
  defaultPropertyId,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  defaultPropertyId: string | null
  onCreated: (ref: string) => void
}) {
  const me = useMe()
  const props = me.data?.properties
  const firstId = props?.[0]?.id ?? ""
  const people = useQuery<{ people: Person[] }, ApiError>({
    queryKey: ["action-owner-options"],
    queryFn: () => api.get("/api/actions/owner-options"),
    staleTime: 300_000,
    enabled: open,
  })
  const blank = React.useCallback(
    () => ({
      property_id: defaultPropertyId ?? firstId,
      description: "",
      type: "action",
      priority: "med",
      owner_id: "",
      gate_ref: "",
      due_on: "",
    }),
    [defaultPropertyId, firstId],
  )
  const [f, setF] = React.useState(blank)
  React.useEffect(() => {
    if (open) setF(blank())
  }, [open, blank])
  const up =
    (k: keyof ReturnType<typeof blank>) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setF((x) => ({ ...x, [k]: e.target.value }))
  const create = useMutation({
    mutationFn: () =>
      api.post<{ ref: string; id: string }>("/api/actions", {
        property_id: f.property_id,
        description: f.description.trim(),
        type: f.type,
        priority: f.priority,
        owner_id: f.owner_id || null,
        gate_ref: f.gate_ref.trim().toUpperCase() || null,
        due_on: f.due_on || null,
        source: "manual",
      }),
    onSuccess: (r) => {
      toast(`${r.ref} raised`)
      onOpenChange(false)
      onCreated(r.ref)
    },
    onError: (e: ApiError) => toastError(e.message),
  })
  const ok = f.property_id && f.description.trim().length > 2
  return (
    <QDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={create.isPending}
      width={520}
      title="New Action"
      sub="Say what needs fixing. Urgent closes in 7 days, Soon in 30, Later in 90."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!ok || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Raising…" : "Raise Action"}
          </Button>
        </>
      }
    >
      <Field label="Property">
        <select value={f.property_id} onChange={up("property_id")} className={inputCls}>
          {(props ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What needs fixing?">
        <textarea
          rows={3}
          value={f.description}
          onChange={up("description")}
          placeholder="e.g. Fire door to room 7 doesn't close fully"
          className={textareaCls}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Type">
          <select value={f.type} onChange={up("type")} className={inputCls}>
            <option value="action">Action</option>
            <option value="work_required">Work required</option>
            <option value="advisory">Advisory (needs a decision)</option>
          </select>
        </Field>
        <Field label="Priority">
          <select value={f.priority} onChange={up("priority")} className={inputCls}>
            <option value="high">Urgent · 7 days</option>
            <option value="med">Soon · 30 days</option>
            <option value="low">Later · 90 days</option>
          </select>
        </Field>
      </div>
      <Field label="Owner" hint="(a named person)">
        <select value={f.owner_id} onChange={up("owner_id")} className={inputCls}>
          <option value="">Decide later</option>
          {(people.data?.people ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.sub ? ` · ${p.sub}` : ""}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Gate ref" hint="(optional)">
          <input value={f.gate_ref} onChange={up("gate_ref")} placeholder="e.g. C09" className={inputCls} />
        </Field>
        <Field label="Due" hint="(optional)">
          <input type="date" value={f.due_on} onChange={up("due_on")} className={inputCls} />
        </Field>
      </div>
    </QDialog>
  )
}
