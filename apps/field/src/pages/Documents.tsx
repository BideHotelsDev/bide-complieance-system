/*
 * My documents (design: AppDocs, DOC-03). Training and checks the person's roles need. Never kept on the phone: this
 * list is fetched fresh each time and not cached for offline use (§8 Offline).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError, upload } from "@bide-comply/api-client"
import { Pill, type Tone } from "@bide-comply/ui/components/status"
import { toastError } from "@bide-comply/ui/components/toaster"
import { Check, CircleAlert } from "lucide-react"
import * as React from "react"

import {
  Card,
  ErrorBox,
  FieldLabel,
  Loading,
  SecondaryButton,
  SelectBox,
  Spinner,
  TabScreen,
  TextInput,
} from "@/components/kit"
import { Sheet } from "@/components/Sheet"
import { toastCouldntSave, toastSent } from "@/components/sync"
import type { Documents } from "@/lib/types"

const TONE: Record<Documents["rows"][number]["status"], Tone> = {
  ok: "green",
  expiring: "amber",
  expired: "red",
  missing: "red",
  pending: "blue",
}

export function DocumentsPage() {
  const q = useQuery({
    queryKey: ["documents"],
    queryFn: () => api.get<Documents>("/api/field/documents"),
    gcTime: 0,
  })
  const [open, setOpen] = React.useState(false)
  const needs = q.data?.rows.filter((r) => r.status !== "ok" && r.status !== "pending").length ?? 0
  return (
    <TabScreen title="My documents" subtitle="Training and checks your role needs">
      {q.isPending ? (
        <Loading label="Loading your documents" />
      ) : q.error ? (
        <ErrorBox
          message={
            (q.error as ApiError).status === 0
              ? "Your documents aren't kept on this phone. Open this page when you have signal."
              : q.error.message
          }
          onRetry={() => void q.refetch()}
        />
      ) : (
        <>
          {q.data.all_set ? (
            <div className="flex items-start gap-3 rounded-xl border border-st-green/25 bg-st-green-bg px-4 py-3.5 text-[15px] text-st-green">
              <Check aria-hidden className="mt-0.5 size-5 shrink-0" />
              <span>
                <strong>You're all set.</strong> Everything your roles need is on file.
              </span>
            </div>
          ) : needs > 0 ? (
            <div className="flex items-start gap-3 rounded-xl border border-st-red/25 bg-st-red-bg px-4 py-3.5 text-[15px] text-st-red">
              <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0" />
              <span>
                <strong>
                  {needs} thing{needs === 1 ? "" : "s"} need{needs === 1 ? "s" : ""} you.
                </strong>{" "}
                Upload the certificate and it will be checked.
              </span>
            </div>
          ) : null}
          {q.data.rows.length > 0 && (
            <Card>
              <ul className="m-0 list-none p-0">
                {q.data.rows.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 border-b border-divider px-3.5 py-3 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-[16px] font-semibold">{r.title}</div>
                      {r.detail && <div className="text-[14px] text-muted-foreground">{r.detail}</div>}
                    </div>
                    <Pill tone={TONE[r.status]}>{r.label}</Pill>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card className="px-4 py-3.5">
            <div className="text-[16px] font-semibold">Did a new course?</div>
            <p className="m-0 mt-1 mb-3 text-[15px] text-muted-foreground">
              Upload the certificate and {q.data.checker ?? "the register keeper"} will check it.
            </p>
            <SecondaryButton onClick={() => setOpen(true)}>Upload a certificate</SecondaryButton>
          </Card>
          <UploadSheet open={open} onClose={() => setOpen(false)} types={q.data.types} />
        </>
      )}
    </TabScreen>
  )
}

function UploadSheet({ open, onClose, types }: { open: boolean; onClose: () => void; types: Documents["types"] }) {
  const qc = useQueryClient()
  const [type, setType] = React.useState("")
  const [file, setFile] = React.useState<File | null>(null)
  const [expires, setExpires] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const send = async () => {
    if (!file || !type) return
    setBusy(true)
    try {
      const up = await upload(file, { captured_with: "upload", purpose: "evidence" })
      await api.post("/api/field/documents", { type_key: type, evidence_id: up.id, expires_on: expires || null })
      toastSent("Certificate sent. It will be checked.")
      void qc.invalidateQueries({ queryKey: ["documents"] })
      setFile(null)
      setType("")
      setExpires("")
      onClose()
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) toastCouldntSave(() => void send())
      else toastError(e instanceof Error ? e.message : "Couldn't upload. Try again.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Upload a certificate"
      description="A photo or PDF of the certificate. It's kept securely and only the people who check it can see it."
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-12 flex-1 rounded-xl border border-border bg-surface text-[16px] font-semibold"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!file || !type || busy}
            onClick={() => void send()}
            className="flex h-12 flex-[1.6] items-center justify-center gap-2 rounded-xl bg-primary text-[16px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy && <Spinner />}
            Upload
          </button>
        </>
      }
    >
      <div>
        <FieldLabel htmlFor="doc-type">Which course or check?</FieldLabel>
        <SelectBox
          id="doc-type"
          value={type}
          onChange={setType}
          options={types.map((t) => ({ value: t.key, label: t.name }))}
        />
      </div>
      <div>
        <FieldLabel htmlFor="doc-file">Certificate</FieldLabel>
        <label className="flex h-12 cursor-pointer items-center justify-center truncate rounded-xl border border-dashed border-subtle bg-surface px-3 text-[15.5px] font-semibold">
          {file ? file.name : "Choose a photo or PDF"}
          <input
            id="doc-file"
            type="file"
            accept="application/pdf,image/*"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>
      <div>
        <FieldLabel htmlFor="doc-exp" help="If the certificate shows one">
          Expires on
        </FieldLabel>
        <TextInput id="doc-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </div>
    </Sheet>
  )
}
