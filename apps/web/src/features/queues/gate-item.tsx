/* Edit one opening-checklist item (design: Opening checklist › Mark items). No evidence, not done. */
import { useMutation, useQuery } from "@tanstack/react-query"
import * as React from "react"

import { api, ApiError, upload } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { ClassBadge } from "@bide-comply/ui/components/status"
import { toast, toastError } from "@bide-comply/ui/components/toaster"

import type { GateItem, Person } from "./types"
import { DropZone, Field, inputCls, Note, QDialog, textareaCls } from "./ui"

export const GATE_STATUSES = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "to_confirm", label: "To confirm" },
  { value: "done", label: "Done" },
  { value: "na", label: "N/A (doesn't apply here)" },
] as const

export function saveItem(id: string, body: Record<string, unknown>) {
  return api.patch<{ status: string }>(`/api/gate-items/${id}`, body)
}

export function GateItemDialog({
  item,
  propertyId,
  onDone,
  onSaved,
}: {
  item: GateItem
  propertyId: string
  onDone: () => void
  onSaved: () => void
}) {
  const people = useQuery<{ people: Person[] }, ApiError>({
    queryKey: ["action-owner-options"],
    queryFn: () => api.get("/api/actions/owner-options"),
    staleTime: 300_000,
  })
  const [status, setStatus] = React.useState<string>(item.status)
  const [naReason, setNaReason] = React.useState(item.na_reason ?? "")
  const [notes, setNotes] = React.useState(item.notes ?? "")
  const [link, setLink] = React.useState(item.evidence_link ?? "")
  const [owner, setOwner] = React.useState("")
  const [due, setDue] = React.useState(item.due_on ?? "")
  const [files, setFiles] = React.useState<{ id: string; name: string }[]>([])
  const [uploading, setUploading] = React.useState(false)
  const isH08 = item.ref === "H08"

  const addFiles = async (fs: File[]) => {
    setUploading(true)
    try {
      for (const f of fs) {
        const up = await upload(f, { captured_with: "upload", property_id: propertyId, file_name: f.name })
        setFiles((x) => [...x, { id: up.id, name: up.file_name }])
      }
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : "The upload didn't finish. Try again.")
    } finally {
      setUploading(false)
    }
  }

  const hasEvidence = !!link.trim() || item.evidence.length > 0 || files.length > 0
  const save = useMutation({
    mutationFn: () =>
      saveItem(item.id, {
        status: status !== item.status ? status : null,
        na_reason: status === "na" ? naReason.trim() || null : null,
        notes: notes !== (item.notes ?? "") ? notes : null,
        evidence_link: link.trim() !== (item.evidence_link ?? "") ? link.trim() : null,
        evidence_ids: files.map((f) => f.id),
        owner_id: owner || null,
        due_on: due && due !== item.due_on ? due : null,
      }),
    onSuccess: (r) => {
      if (status === "done" && r.status === "to_confirm")
        toast(`${item.ref} saved as To confirm. Attach the evidence to mark it Done.`)
      else toast(`${item.ref} saved`)
      onSaved()
      onDone()
    },
    onError: (e: ApiError) => toastError(e.message),
  })
  const blocked = status === "na" && !naReason.trim()
  return (
    <QDialog
      open
      onOpenChange={(o) => !o && onDone()}
      busy={save.isPending}
      width={560}
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono text-[13px] text-muted-foreground">{item.ref}</span>
          <ClassBadge klass={item.class} />
          <span className="min-w-0">Mark item</span>
        </span>
      }
      sub={item.item}
      footer={
        <>
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button disabled={blocked || save.isPending || uploading} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save item"}
          </Button>
        </>
      }
    >
      {item.evidence_required && (
        <div className="text-[13px]">
          <span className="text-muted-foreground">Evidence required: </span>
          {item.evidence_required}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls} disabled={isH08}>
            {GATE_STATUSES.map((s) => (
              <option key={s.value} value={s.value} disabled={isH08 && s.value === "done"}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due" hint="(optional)">
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} />
        </Field>
      </div>
      {isH08 && <Note>H08 is done by the dutyholder signing the checklist.</Note>}
      {status === "na" && (
        <Field label="Why doesn't it apply here?">
          <input
            value={naReason}
            onChange={(e) => setNaReason(e.target.value)}
            placeholder="e.g. No lift in the building"
            className={inputCls}
          />
        </Field>
      )}
      {status === "done" && !hasEvidence && (
        <Note>No evidence yet. Without it the item is saved as To confirm, not Done.</Note>
      )}
      <Field label="Owner" hint={item.owner ? `(now ${item.owner})` : "(a named person)"}>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls}>
          <option value="">{item.owner ? "Keep as it is" : "Choose a person"}</option>
          {(people.data?.people ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.sub ? ` · ${p.sub}` : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Where the evidence is" hint="(folder or link)">
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="e.g. 05 Certificates & Evidence/C01"
          className={inputCls}
        />
      </Field>
      {(item.evidence.length > 0 || files.length > 0) && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
          {[...item.evidence, ...files].map((f) => (
            <li key={f.id} className="truncate rounded-md border border-divider px-2.5 py-1.5">
              {f.name}
            </li>
          ))}
        </ul>
      )}
      <DropZone busy={uploading} onFiles={(f) => void addFiles(f)} title="Add evidence: a photo, scan or certificate" />
      <Field label="Notes">
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className={textareaCls} />
      </Field>
    </QDialog>
  )
}
