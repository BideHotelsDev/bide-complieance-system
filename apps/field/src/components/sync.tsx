/*
 * What the phone is holding (§8 Offline): a banner that stays while there is no signal, the sync pill on Today, and
 * each waiting check with its own upload status. Small confirmations follow design: Dialogs › Small confirmations.
 */
import { Pill } from "@bide-comply/ui/components/status"
import { toast } from "@bide-comply/ui/components/toaster"
import { Check, CloudOff, RefreshCw, Trash2, TriangleAlert } from "lucide-react"

import { removeQueued, syncQueue, useOnline, useQueue, type QueuedCheck } from "@/lib/queue"
import { fmtTime } from "@/lib/format"

export function toastSent(text = "Check sent. Thank you.") {
  toast(text, { icon: <Check aria-hidden className="size-4 text-st-green" /> })
}

export function toastSaved() {
  toast("Saved on this phone. Sends when you're online.", {
    icon: <span aria-hidden className="inline-block size-2.5 rounded-full bg-st-amber" />,
  })
}

export function toastCouldntSave(retry?: () => void) {
  toast("Couldn't save. Check your connection.", {
    duration: Infinity,
    closeButton: true,
    icon: <span aria-hidden className="font-bold">!</span>,
    action: retry ? { label: "Try again", onClick: retry } : undefined,
    className: "!bg-st-red !text-white",
  })
}

export function OfflineBanner() {
  const online = useOnline()
  const queue = useQueue()
  if (online) return null
  return (
    <div role="status" className="sticky top-0 z-30 flex items-center gap-2 bg-foreground px-4 py-2.5 text-[14px] text-background">
      <CloudOff aria-hidden className="size-4 shrink-0" />
      <span>
        You're offline. Checks are saved on this phone
        {queue.length ? ` (${queue.length} waiting)` : ""} and send when you're back online.
      </span>
    </div>
  )
}

export function SyncPill() {
  const online = useOnline()
  const queue = useQueue()
  const failed = queue.filter((q) => q.status === "failed").length
  const sending = queue.some((q) => q.status === "sending")
  if (failed) return <Pill tone="red">{failed} couldn't send</Pill>
  if (sending)
    return (
      <Pill tone="blue">
        <RefreshCw aria-hidden className="size-3 animate-spin" />
        Sending
      </Pill>
    )
  if (queue.length)
    return (
      <Pill tone="amber" dot>
        {queue.length} waiting to send
      </Pill>
    )
  if (!online)
    return (
      <Pill tone="grey">
        <CloudOff aria-hidden className="size-3" />
        Offline
      </Pill>
    )
  return (
    <Pill tone="green">
      <Check aria-hidden className="size-3" />
      All synced
    </Pill>
  )
}

function itemStatus(q: QueuedCheck, online: boolean): { text: string; tone: "amber" | "blue" | "red" } {
  if (q.status === "failed") return { text: q.error ?? "Couldn't send", tone: "red" }
  if (q.status === "sending") {
    const done = q.photos.filter((p) => p.evidence_id).length
    return {
      text: done < q.photos.length ? `Sending photo ${done + 1} of ${q.photos.length}` : "Sending the check",
      tone: "blue",
    }
  }
  const up = q.photos.filter((p) => p.evidence_id).length
  return {
    text: online ? "Waiting to send" : `Waiting for signal${q.photos.length ? ` · ${up} of ${q.photos.length} photos sent` : ""}`,
    tone: "amber",
  }
}

/* Checks saved on the phone, each with where its upload has got to. */
export function WaitingList() {
  const queue = useQueue()
  const online = useOnline()
  if (!queue.length) return null
  return (
    <section aria-label="Waiting to send" className="flex flex-col gap-2.5">
      <h2 className="m-0 mt-2 text-[14px] font-semibold text-st-amber">On this phone · {queue.length}</h2>
      {queue.map((q) => {
        const st = itemStatus(q, online)
        return (
          <div key={q.id} className="rounded-xl border border-divider bg-surface px-3.5 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[16px] font-semibold">{q.title}</div>
                <div className="text-[13.5px] text-muted-foreground">
                  Done {fmtTime(q.device_time)} · {q.photos.length} photo{q.photos.length === 1 ? "" : "s"}
                </div>
              </div>
              <Pill tone={st.tone} dot={st.tone === "amber"}>
                {st.tone === "red" ? "Not sent" : st.tone === "blue" ? "Sending" : "Waiting"}
              </Pill>
            </div>
            <p className={`m-0 mt-1.5 text-[13.5px] ${st.tone === "red" ? "text-st-red" : "text-muted-foreground"}`}>
              {st.tone === "red" && <TriangleAlert aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />}
              {st.text}
            </p>
            {q.status === "failed" && (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="h-11 flex-1 rounded-lg border border-border text-[15px] font-semibold"
                  onClick={() => void syncQueue({ includeFailed: true })}
                >
                  Try again
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${q.title} from this phone`}
                  className="flex h-11 w-12 items-center justify-center rounded-lg border border-border text-st-red"
                  onClick={() => void removeQueued(q.id)}
                >
                  <Trash2 aria-hidden className="size-4" />
                </button>
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
