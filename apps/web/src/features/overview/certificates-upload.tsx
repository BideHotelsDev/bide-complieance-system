/*
 * Upload a certificate (DOC-01): against a required one (closes its linked Action only if it has no fails), as a
 * renewal that replaces one on file, or as a new certificate. The file goes up first, then the dates are filed.
 */
import { useQueryClient } from "@tanstack/react-query"
import * as React from "react"

import { api, upload, type ApiError } from "@bide-comply/api-client"
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
import { toast } from "@bide-comply/ui/components/toaster"

import { useMe } from "../../lib/session"

export type CertRow = {
  id: string
  title: string
  property: string | null
  property_code: string | null
  property_id: string | null
  why: string | null
  provider: string | null
  issuer: string | null
  issued_on: string | null
  expires_on: string | null
  action_ref: string | null
  file_name: string | null
  status: "missing" | "due" | "partial" | "fails" | "expired" | "expiring" | "valid"
  status_label: string
  fail_count: number
  kind_label: string
  evidence_id?: string | null
  register_item_id?: string | null
  register_ref?: string | null
}

export const isRequired = (c: CertRow) => c.status === "missing" || c.status === "due" || c.status === "partial"

const NEW = "__new"
const selectCls =
  "h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13.5px] outline-none focus-visible:outline-2 focus-visible:outline-focus"

export function UploadCertificateDialog({
  open,
  onOpenChange,
  target,
  required,
  defaultPropertyId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The row the person clicked Upload on; null from the header button. */
  target: CertRow | null
  /** Required certificates the header button can file against. */
  required: CertRow[]
  defaultPropertyId: string | null
}) {
  const me = useMe()
  const qc = useQueryClient()
  const [pick, setPick] = React.useState<string>(NEW)
  const [propertyId, setPropertyId] = React.useState<string>("")
  const [title, setTitle] = React.useState("")
  const [file, setFile] = React.useState<File | null>(null)
  const [issued, setIssued] = React.useState("")
  const [expires, setExpires] = React.useState("")
  const [issuer, setIssuer] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setPick(target ? target.id : (required[0]?.id ?? NEW))
    setPropertyId(target?.property_id ?? defaultPropertyId ?? me.data?.properties[0]?.id ?? "")
    setTitle(target && !isRequired(target) ? target.title : "")
    setFile(null)
    setIssued("")
    setExpires("")
    setIssuer(target?.issuer ?? "")
    setError(null)
  }, [open, target, required, defaultPropertyId, me.data])

  const chosen = target ?? required.find((r) => r.id === pick) ?? null
  const fileAgainstRequired = chosen != null && isRequired(chosen)
  const renewing = chosen != null && !isRequired(chosen)
  const pid = chosen?.property_id ?? propertyId

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!file) return setError("Choose the certificate file.")
    if (!issued) return setError("Add the date it was issued.")
    if (expires && expires < issued) return setError("The expiry date is before the issue date.")
    if (!fileAgainstRequired && !renewing && !title.trim()) return setError("Say what the certificate is.")
    if (!pid) return setError("Choose the property.")
    setBusy(true)
    try {
      const up = await upload(file, { captured_with: "upload", property_id: pid, file_name: file.name })
      const dates = {
        evidence_id: up.id,
        issued_on: issued,
        expires_on: expires || null,
        issuer: issuer.trim() || null,
      }
      let closed = false
      if (fileAgainstRequired && chosen) {
        const r = await api.post<{ ok: boolean; linked_action: string | null }>(
          `/api/certificates/${chosen.id}/file`,
          dates,
        )
        closed = !!r.linked_action && chosen.fail_count === 0
      } else {
        await api.post("/api/certificates", {
          ...dates,
          property_id: pid,
          title: (renewing ? title || chosen?.title : title)?.trim(),
          replaces: renewing ? chosen?.id : null,
        })
      }
      await qc.invalidateQueries({ queryKey: ["certificates"] })
      toast(
        `Filed ${renewing || fileAgainstRequired ? chosen?.title : title.trim()}${
          closed && chosen?.action_ref ? `. ${chosen.action_ref} can now close.` : "."
        }`,
      )
      onOpenChange(false)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="bg-surface sm:max-w-[520px]">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{renewing ? "Upload new certificate" : "Upload a certificate"}</DialogTitle>
            <DialogDescription>
              {fileAgainstRequired
                ? "Uploading a certificate closes its linked action only if it has no fails."
                : renewing
                  ? "The new certificate replaces the one on file. The old one stays in the history."
                  : "File a certificate with its dates so reminders go out 60, 30 and 14 days before it expires."}
            </DialogDescription>
          </DialogHeader>

          {!target && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cert-pick">Certificate</Label>
              <select id="cert-pick" className={selectCls} value={pick} onChange={(e) => setPick(e.target.value)}>
                {required.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                    {r.property ? ` · ${r.property}` : ""}
                  </option>
                ))}
                <option value={NEW}>Another certificate (not on the required list)</option>
              </select>
            </div>
          )}
          {target && (
            <div className="text-[13.5px]">
              <div className="font-medium">{target.title}</div>
              <div className="text-muted-foreground">{[target.property, target.why].filter(Boolean).join(" · ")}</div>
            </div>
          )}

          {!chosen && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cert-title">What it is</Label>
                <Input
                  id="cert-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="For example, Gas Safe CP12"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cert-prop">Property</Label>
                <select
                  id="cert-prop"
                  className={selectCls}
                  value={propertyId}
                  onChange={(e) => setPropertyId(e.target.value)}
                >
                  {(me.data?.properties ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cert-file">File</Label>
            <Input
              id="cert-file"
              type="file"
              accept="application/pdf,image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cert-issued">Issued on</Label>
              <Input id="cert-issued" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cert-expires">Expires on</Label>
              <Input id="cert-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cert-issuer">Issued by</Label>
            <Input
              id="cert-issuer"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="Company or engineer"
            />
          </div>
          {error && (
            <Callout tone="red" className="py-2">
              {error}
            </Callout>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Uploading…" : "Upload certificate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
