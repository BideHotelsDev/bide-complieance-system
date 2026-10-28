/*
 * Mark as not applicable (design: Dialogs › Mark as not applicable?, SCH-10). Always a request a manager agrees to;
 * the note is required. Life-safety checks say so plainly.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { api } from "@bide-comply/api-client"
import * as React from "react"

import { fmtDay } from "@/lib/format"
import type { TaskDetail } from "@/lib/types"

import { FieldLabel, SelectBox, TextArea } from "./kit"
import { Sheet } from "./Sheet"
import { toastCouldntSave, toastSent } from "./sync"

const REASONS = [
  "Closed for repairs",
  "Not in use this season",
  "Area closed to guests",
  "Equipment removed",
  "Done by a contractor this time",
  "Other",
]

export function NaSheet({ open, onClose, task }: { open: boolean; onClose: () => void; task: TaskDetail }) {
  const [reason, setReason] = React.useState(REASONS[0])
  const [note, setNote] = React.useState("")
  const navigate = useNavigate()
  const qc = useQueryClient()
  const classA = task.class === "A"
  const send = useMutation({
    mutationFn: () => api.post(`/api/field/tasks/${task.task_id}/na`, { reason, note }),
    onSuccess: () => {
      toastSent("Sent to your manager to agree.")
      void qc.invalidateQueries({ queryKey: ["today"] })
      onClose()
      void navigate({ to: "/" })
    },
    onError: (e) => {
      if ((e as { status?: number }).status === 0) toastCouldntSave(() => send.mutate())
    },
  })
  const due = new Date(task.due_at)
  const dueLabel = due.toDateString() === new Date().toDateString() ? "due today" : `due ${fmtDay(due)}`
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Mark as not applicable?"
      description={`${task.title} · ${task.property} · ${dueLabel}`}
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
            disabled={!note.trim() || send.isPending}
            onClick={() => send.mutate()}
            className="h-12 flex-[1.6] rounded-xl bg-primary text-[16px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            Ask manager to agree
          </button>
        </>
      }
    >
      <div>
        <FieldLabel htmlFor="na-reason">Reason</FieldLabel>
        <SelectBox id="na-reason" value={reason} onChange={setReason} options={REASONS.map((r) => ({ value: r, label: r }))} />
      </div>
      <div>
        <FieldLabel htmlFor="na-note">Note (required)</FieldLabel>
        <TextArea id="na-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's happening, and until when?" />
      </div>
      {send.error && (send.error as { status?: number }).status !== 0 && (
        <p role="alert" className="m-0 text-[14.5px] text-st-red">
          {send.error.message}
        </p>
      )}
      <p className="m-0 rounded-xl bg-st-grey-bg px-4 py-3 text-[14.5px] text-ink2">
        {classA
          ? "Life-safety checks can't be marked not applicable by staff. A manager must agree."
          : "Your manager will be asked to agree. Until then the check stays on your list."}
      </p>
    </Sheet>
  )
}
