/*
 * Problem found › Add a note or photo (design: AppResult). Adds to the Action the failed check raised, so whoever fixes
 * it sees it. Photos come from the in-app camera, as everywhere else (EXE-02).
 */
import { api, ApiError } from "@bide-comply/api-client"
import { toastError } from "@bide-comply/ui/components/toaster"
import { Camera as CameraIcon, X } from "lucide-react"
import * as React from "react"

import { shortName } from "@/lib/format"
import { useMe } from "@/lib/session"
import { useShots } from "@/lib/shots"

import { Camera } from "./Camera"
import { FieldLabel, Spinner, TextArea } from "./kit"
import { Sheet } from "./Sheet"
import { toastCouldntSave, toastSent } from "./sync"

export function AddToAction({
  open,
  onClose,
  actionRef,
  propertyId,
  propertyName,
  taskId,
}: {
  open: boolean
  onClose: () => void
  actionRef: string
  propertyId: string
  propertyName: string
  taskId?: string
}) {
  const me = useMe()
  const [note, setNote] = React.useState("")
  const [camera, setCamera] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const { shots, add, remove, ensureUploaded } = useShots({ property_id: propertyId, task_id: taskId, ref: actionRef })

  const send = async () => {
    setBusy(true)
    try {
      const up = await ensureUploaded()
      if (up.status === "offline") return toastCouldntSave(() => void send())
      if (up.status === "error") return toastError("A photo didn't finish uploading. Take it again.")
      await api.post(`/api/field/actions/${actionRef}/add`, {
        note: note.trim() || null,
        photos: up.shots.map((s) => s.evidence_id).filter(Boolean),
      })
      toastSent(`Added to ${actionRef}. Thank you.`)
      setNote("")
      up.shots.forEach((s) => remove(s.id))
      onClose()
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) toastCouldntSave(() => void send())
      else toastError(e instanceof Error ? e.message : "Couldn't send. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Sheet
        open={open && !camera}
        onClose={onClose}
        title="Add a note or photo"
        description={`Goes on ${actionRef}, so whoever fixes it can see it.`}
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
              disabled={busy || (!note.trim() && shots.length === 0)}
              onClick={() => void send()}
              className="flex h-12 flex-[1.6] items-center justify-center gap-2 rounded-xl bg-primary text-[16px] font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy && <Spinner />}
              Add to {actionRef}
            </button>
          </>
        }
      >
        <div>
          <FieldLabel htmlFor="add-note">Note</FieldLabel>
          <TextArea
            id="add-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything that helps whoever fixes it"
          />
        </div>
        <div>
          <div className="mb-2 text-[16px] font-semibold">Photo</div>
          <div className="flex flex-wrap gap-2.5">
            {shots.map((s) => (
              <div key={s.id} className="relative size-[88px] overflow-hidden rounded-xl bg-hover">
                <img src={s.url} alt="Photo to add" className="size-full object-cover" />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => remove(s.id)}
                  className="absolute top-1 right-1 flex size-8 items-center justify-center rounded-full bg-black/60 text-white"
                >
                  <X aria-hidden className="size-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setCamera(true)}
              className="flex size-[88px] flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-subtle bg-surface text-[14.5px] font-semibold"
            >
              <CameraIcon aria-hidden className="size-5" />
              Photo
            </button>
          </div>
        </div>
      </Sheet>
      {camera && (
        <Camera
          title="Photo of the problem"
          hint="Show what's wrong and where it is"
          index={shots.length + 1}
          total={shots.length + 1}
          stampPrefix={`${propertyName} · ${actionRef} · ${shortName(me.data?.name ?? "")}`}
          onClose={() => setCamera(false)}
          onCapture={(blob, at) => {
            add("action", blob, at)
            setCamera(false)
          }}
        />
      )}
    </>
  )
}
