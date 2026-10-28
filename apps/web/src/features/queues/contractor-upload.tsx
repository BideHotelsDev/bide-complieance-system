/*
 * Evidence review › From contractors: one report or fix photo sent from the contractor portal. Nothing a contractor
 * sends counts until it's checked here. Approve marks the visit done (and files the certificate) or closes the Action
 * with the photo as closing evidence; Send back needs a comment, which the contractor sees in the portal.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"
import { Check, Lock } from "lucide-react"

import { api, type ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Callout, ErrorState, Skeleton } from "@bide-comply/ui/components/page"
import { ClassBadge, Pill } from "@bide-comply/ui/components/status"
import { toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { fmtDateTime } from "@/lib/format"
import type { EvidenceFile } from "./types"

type Upload = {
  id: string
  kind: "report" | "fix"
  status: "pending" | "approved" | "rejected"
  ref: string | null
  class: "A" | "B" | "C" | null
  title: string
  subtitle: string
  description: string | null
  contractor: string
  sent_by: string
  sent_at: string
  note: string | null
  files: EvidenceFile[]
  on_approve: string
  can_decide: boolean
  review: { by: string; at: string; comment: string | null } | null
}

export function ContractorUpload({ id, onDecided }: { id: string; onDecided: (label: string) => void }) {
  const qc = useQueryClient()
  const res = useQuery<Upload, ApiError>({
    queryKey: ["contractor-upload", id],
    queryFn: () => api.get<Upload>(`/api/contractor-uploads/${id}`),
  })
  const [comment, setComment] = React.useState("")
  const [needComment, setNeedComment] = React.useState(false)
  const commentRef = React.useRef<HTMLInputElement>(null)
  const u = res.data

  const decide = useMutation({
    mutationFn: (result: "approved" | "rejected") =>
      api.post(`/api/contractor-uploads/${id}/decide`, { result, comment: comment.trim() || null }),
    onSuccess: (_d, result) => {
      void qc.invalidateQueries({ queryKey: ["contractor-upload", id] })
      void qc.invalidateQueries({ queryKey: ["actions"] })
      void qc.invalidateQueries({ queryKey: ["action"] })
      const what =
        result === "rejected"
          ? `Sent back to ${u?.contractor ?? "the contractor"}.`
          : u?.kind === "fix"
            ? `Approved. ${u.ref ?? "The Action"} is closed.`
            : "Approved. The visit is done."
      onDecided(what)
    },
    onError: (e: ApiError) => toastError(e.message),
  })

  const act = (result: "approved" | "rejected") => {
    if (result === "rejected" && !comment.trim()) {
      setNeedComment(true)
      commentRef.current?.focus()
      return
    }
    decide.mutate(result)
  }

  if (res.error)
    return (
      <div className="rounded-[10px] border border-divider bg-surface">
        <ErrorState
          title={res.error.status === 404 ? "This upload wasn't found" : undefined}
          onRetry={res.error.status === 404 ? undefined : () => void res.refetch()}
        />
      </div>
    )
  if (!u)
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading upload">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="h-72" />
      </div>
    )

  const canAct = u.can_decide && u.status === "pending"
  return (
    <>
      <header className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {u.class && <ClassBadge klass={u.class} />}
          {u.ref && <span className="mono-id text-[12px]">{u.ref}</span>}
          <Pill tone={u.status === "pending" ? "blue" : u.status === "approved" ? "green" : "amber"}>
            {u.status === "pending" ? "Waiting for a check" : u.status === "approved" ? "Approved" : "Sent back"}
          </Pill>
          <Pill tone="grey">From {u.contractor}</Pill>
        </div>
        <h2 className="m-0 mt-1.5 text-[18px] font-semibold">{u.title}</h2>
        <p className="m-0 mt-0.5 text-muted-foreground">{u.subtitle}</p>
      </header>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
        <div className="flex flex-col gap-3 rounded-[10px] border border-divider bg-surface p-3.5">
          <span className="font-semibold">
            {u.kind === "report" ? "Report" : "Photo"} · {u.files.length} {u.files.length === 1 ? "file" : "files"}
          </span>
          <div className="grid grid-cols-2 gap-2.5">
            {u.files.map((f, i) => (
              <a
                key={f.id}
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="relative block h-[210px] overflow-hidden rounded-lg bg-hover"
              >
                {f.content_type.startsWith("image/") ? (
                  <img src={f.url} alt={`File ${i + 1}: ${f.file_name}`} className="size-full object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center p-4 text-center text-[13px] text-st-grey">
                    {f.file_name}
                  </span>
                )}
              </a>
            ))}
          </div>
          <Pill tone="green" className="self-start">
            Original kept, unaltered
          </Pill>
        </div>
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-divider bg-surface p-3.5">
          <span className="font-semibold">Details</span>
          <dl className="m-0 grid grid-cols-[110px_1fr] gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">Sent by</dt>
            <dd className="m-0">{u.sent_by === u.contractor ? u.sent_by : `${u.sent_by} (${u.contractor})`}</dd>
            <dt className="text-muted-foreground">Sent</dt>
            <dd className="m-0">{fmtDateTime(u.sent_at)}</dd>
            {u.description && (
              <>
                <dt className="text-muted-foreground">The Action</dt>
                <dd className="m-0">{u.description}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Their note</dt>
            <dd className="m-0">{u.note ?? <span className="text-muted-foreground">None</span>}</dd>
          </dl>
        </div>
      </div>

      {u.review ? (
        <Callout tone={u.status === "approved" ? "green" : "amber"} icon={<Lock className="size-4" />}>
          {u.status === "approved" ? "Approved" : "Sent back"} by {u.review.by}, {fmtDateTime(u.review.at)}
          {u.review.comment ? `: “${u.review.comment}”.` : "."}
        </Callout>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-divider bg-surface p-3.5">
            <label className="flex min-w-0 flex-[1_1_320px] flex-col gap-[5px]">
              <span className="text-[12px] font-medium text-ink2">
                Comment <span className="font-normal text-muted-foreground">(required to send back)</span>
              </span>
              <input
                ref={commentRef}
                value={comment}
                disabled={!canAct}
                aria-invalid={needComment && !comment.trim()}
                onChange={(e) => {
                  setComment(e.target.value)
                  setNeedComment(false)
                }}
                placeholder={
                  u.kind === "fix" ? "e.g. The photo doesn't show the repair" : "e.g. The certificate isn't signed"
                }
                className={cn(
                  "h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-focus",
                  needComment && !comment.trim() && "border-st-red",
                )}
              />
              {needComment && !comment.trim() && (
                <span role="alert" className="text-[12px] text-st-red">
                  Say what's wrong, so the contractor can put it right.
                </span>
              )}
            </label>
            <div className="flex gap-2 self-end">
              <Button
                variant="outline"
                className="border-st-red/30 text-st-red"
                disabled={!canAct || decide.isPending}
                onClick={() => act("rejected")}
              >
                Send back
              </Button>
              <Button disabled={!canAct || decide.isPending} onClick={() => act("approved")}>
                <Check />
                Approve
              </Button>
            </div>
          </div>
          <p className="m-0 text-[12px] text-muted-foreground">
            {u.can_decide ? u.on_approve : "Only someone who can close Actions here can approve a fix."} Send back tells
            the contractor why, in their portal.
          </p>
        </>
      )}
    </>
  )
}
