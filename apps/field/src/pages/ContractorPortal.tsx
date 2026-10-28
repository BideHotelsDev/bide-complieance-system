/*
 * Contractor portal (design: ContractorPortal; PRD §5.5). Contractors open it from the link bide emails them (works 7
 * days, no password). They see only the visits and fixes bide has given their company. "Upload the report after your
 * visit" and "Mark as fixed, add photo" send files to the site manager, who checks them in Evidence review before
 * they count: nothing here closes an Action or files a certificate by itself.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError, upload, type Uploaded } from "@bide-comply/api-client"
import { Mark } from "@bide-comply/ui/components/page"
import { Pill, type Tone } from "@bide-comply/ui/components/status"
import { toastError } from "@bide-comply/ui/components/toaster"
import { Check, FileText, X } from "lucide-react"
import * as React from "react"

import { Card, ErrorBox, Loading, Page, PrimaryButton, SecondaryButton, Spinner, TextArea } from "@/components/kit"
import { Sheet } from "@/components/Sheet"
import { toastCouldntSave, toastSent } from "@/components/sync"
import { fmtSize } from "@/lib/format"

type Item = {
  kind: "visit" | "fix"
  id: string
  ref?: string
  title: string
  badge: string
  badge_tone: Tone
  detail: string
  property: string
  when: string
  description: string | null
  can_upload: boolean
  can_mark_fixed: boolean
  pending: boolean
  sent_back: string | null
}

type Portal = { contractor: string; email_hint: string | null; link_days: number; items: Item[] }

export function ContractorPortalPage() {
  const q = useQuery<Portal, ApiError>({
    queryKey: ["contractor-portal"],
    queryFn: () => api.get<Portal>("/api/contractor-portal"),
  })
  const [sending, setSending] = React.useState<Item | null>(null)

  return (
    <Page>
      <header className="flex items-center gap-2.5 border-b border-divider bg-surface px-[18px] py-4">
        <Mark size={28} />
        <span className="text-[15px] font-semibold">bide Hotels</span>
        <span className="ml-auto text-[13px] text-muted-foreground">Contractor</span>
      </header>
      <main className="flex flex-1 flex-col gap-3 px-4 pt-4 pb-8">
        {q.isPending ? (
          <Loading label="Loading your visits" />
        ) : q.error ? (
          <ErrorBox message={q.error.message} onRetry={q.error.status === 403 ? undefined : () => void q.refetch()} />
        ) : (
          <>
            <div>
              <h1 className="m-0 text-[22px] leading-tight font-semibold">Hello, {q.data.contractor}</h1>
              <p className="m-0 text-[14px] text-muted-foreground">
                This link was sent to {q.data.email_hint ?? "your email"} and works for {q.data.link_days} days. No
                password needed.
              </p>
            </div>
            <h2 className="m-0 text-[13px] font-semibold text-muted-foreground">Your visits</h2>
            {q.data.items.length === 0 ? (
              <Card className="px-3.5 py-4 text-[14px] text-muted-foreground">
                Nothing booked with bide right now. When bide books a visit or gives you something to fix, it appears
                here and we email you.
              </Card>
            ) : (
              q.data.items.map((it) => <ItemCard key={`${it.kind}-${it.id}`} it={it} onSend={() => setSending(it)} />)
            )}
            <Card className="px-3.5 py-3 text-[13px] text-muted-foreground">
              You can only see visits bide has given you. Your uploads are checked by the site manager before they
              count.
            </Card>
          </>
        )}
      </main>
      {sending && <SendSheet it={sending} onClose={() => setSending(null)} />}
    </Page>
  )
}

function ItemCard({ it, onSend }: { it: Item; onSend: () => void }) {
  return (
    <Card className="flex flex-col gap-2 p-3.5">
      <span className="flex items-start justify-between gap-2">
        <span className="font-semibold">{it.title}</span>
        <Pill tone={it.badge_tone}>{it.badge}</Pill>
      </span>
      <span className="text-[14px] text-muted-foreground">{it.detail}</span>
      {it.sent_back && (
        <p role="note" className="m-0 rounded-lg bg-st-amber-bg px-3 py-2 text-[14px] text-st-amber">
          Sent back by the site manager: {it.sent_back}
        </p>
      )}
      {it.can_upload && (
        <PrimaryButton className="h-[46px] text-[16px]" onClick={onSend}>
          {it.sent_back ? "Upload the report again" : "Upload the report after your visit"}
        </PrimaryButton>
      )}
      {it.can_mark_fixed && (
        <SecondaryButton className="h-11 text-[15px]" onClick={onSend}>
          {it.sent_back ? "Add a new photo" : "Mark as fixed, add photo"}
        </SecondaryButton>
      )}
    </Card>
  )
}

type Picked = { file: File; done: Uploaded | null }

function SendSheet({ it, onClose }: { it: Item; onClose: () => void }) {
  const qc = useQueryClient()
  const report = it.kind === "visit"
  const [files, setFiles] = React.useState<Picked[]>([])
  const [note, setNote] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const uploading = files.some((f) => !f.done)
  const ready = files.length > 0 && !uploading && !saving

  const pick = async (list: FileList) => {
    for (const file of Array.from(list).slice(0, 5 - files.length)) {
      setFiles((fs) => [...fs, { file, done: null }])
      try {
        const done = await upload(file, { captured_with: "upload" })
        setFiles((fs) => fs.map((f) => (f.file === file ? { file, done } : f)))
      } catch (e) {
        setFiles((fs) => fs.filter((f) => f.file !== file))
        if (e instanceof ApiError && e.status === 0) toastCouldntSave()
        else toastError(e instanceof Error ? e.message : "The upload didn't finish. Try again.")
      }
    }
  }

  const send = async () => {
    setSaving(true)
    try {
      const path = report
        ? `/api/contractor-portal/visits/${it.id}/report`
        : `/api/contractor-portal/actions/${it.id}/fix`
      const res = await api.post<{ message: string }>(path, {
        evidence_ids: files.map((f) => f.done?.id).filter(Boolean),
        note: note.trim() || null,
      })
      toastSent(res.message)
      void qc.invalidateQueries({ queryKey: ["contractor-portal"] })
      onClose()
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) toastCouldntSave(() => void send())
      else toastError(e instanceof Error ? e.message : "Couldn't send. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={report ? "Upload the report" : "Mark as fixed"}
      description={`${it.title} · ${it.detail}`}
      footer={
        <PrimaryButton disabled={!ready} onClick={() => void send()}>
          {saving && <Spinner />}
          {saving ? "Sending" : report ? "Send the report" : "Send the photo"}
        </PrimaryButton>
      }
    >
      {it.description && <p className="m-0 text-[15px]">{it.description}</p>}
      <div className="flex flex-col gap-2">
        <span className="text-[16px] font-semibold">
          {report ? "Your report or certificate" : "A photo that shows it's fixed"}
        </span>
        {files.map((f) => (
          <div
            key={f.file.name + f.file.size}
            className="flex min-h-[60px] items-center gap-3 rounded-xl border border-divider bg-surface px-3.5 py-2.5"
          >
            <FileText aria-hidden className="size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15.5px]">{f.file.name}</div>
              <div className="text-[13px] text-muted-foreground">
                {fmtSize(f.file.size)} · {f.done ? "uploaded" : "uploading"}
              </div>
            </div>
            {f.done ? (
              <>
                <span className="flex size-7 items-center justify-center rounded-full bg-st-green-bg text-st-green">
                  <Check aria-label="Uploaded" className="size-4" />
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${f.file.name}`}
                  onClick={() => setFiles((fs) => fs.filter((x) => x !== f))}
                  className="flex size-10 items-center justify-center rounded-full text-muted-foreground"
                >
                  <X aria-hidden className="size-4" />
                </button>
              </>
            ) : (
              <Spinner />
            )}
          </div>
        ))}
        {files.length < 5 && (
          <label className="flex h-12 cursor-pointer items-center justify-center rounded-xl border border-dashed border-subtle bg-surface text-[15.5px] font-semibold">
            {files.length ? "Add another" : report ? "Upload the PDF or a photo of it" : "Take or choose a photo"}
            <input
              type="file"
              multiple
              accept={report ? "application/pdf,image/*" : "image/*"}
              capture={report ? undefined : "environment"}
              className="sr-only"
              onChange={(e) => {
                const list = e.target.files
                if (list?.length) void pick(list)
                e.target.value = ""
              }}
            />
          </label>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="cp-note" className="text-[16px] font-semibold">
          Anything the site manager should know?
        </label>
        <TextArea
          id="cp-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={report ? "Optional. For example, what you found" : "Optional. For example, what you replaced"}
        />
      </div>
      <p className="m-0 text-[14px] text-muted-foreground">The site manager checks it before it counts.</p>
    </Sheet>
  )
}
