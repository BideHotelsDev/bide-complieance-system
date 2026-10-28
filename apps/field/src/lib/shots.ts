/*
 * Evidence photos taken in the app. Each one uploads as soon as it is taken when there is signal (so Submit is quick);
 * with no signal the original bytes stay in memory until the check is sent or saved to the phone's queue.
 */
import { ApiError, upload } from "@bide-comply/api-client"
import * as React from "react"

export type Shot = {
  id: string
  key: string
  blob: Blob
  url: string
  captured_at: string
  status: "uploading" | "done" | "local" | "error"
  via: "camera" | "upload"
  evidence_id?: string
  error?: string
}

type Ctx = { property_id?: string | null; task_id?: string | null; ref?: string }
type Outcome = "done" | "offline" | "error"

export function useShots(ctx: Ctx) {
  const [shots, setShots] = React.useState<Shot[]>([])
  const latest = React.useRef<Shot[]>([])
  const ctxRef = React.useRef(ctx)
  const uploaded = React.useRef(new Map<string, string>())
  const inflight = React.useRef(new Map<string, Promise<Outcome>>())

  React.useEffect(() => {
    latest.current = shots
  }, [shots])
  React.useEffect(() => {
    ctxRef.current = ctx
  })
  React.useEffect(
    () => () => {
      latest.current.forEach((s) => URL.revokeObjectURL(s.url))
    },
    [],
  )

  const patch = React.useCallback((id: string, p: Partial<Shot>) => {
    setShots((all) => all.map((s) => (s.id === id ? { ...s, ...p } : s)))
  }, [])

  const send = React.useCallback(
    (s: Shot): Promise<Outcome> => {
      if (uploaded.current.has(s.id)) return Promise.resolve("done")
      const running = inflight.current.get(s.id)
      if (running) return running
      if (!navigator.onLine) {
        patch(s.id, { status: "local" })
        return Promise.resolve("offline")
      }
      patch(s.id, { status: "uploading", error: undefined })
      const c = ctxRef.current
      const p = upload(s.blob, {
        captured_with: s.via,
        property_id: c.property_id ?? null,
        task_id: c.task_id ?? null,
        captured_at: s.captured_at,
        file_name: s.blob instanceof File ? s.blob.name : `${c.ref ?? "photo"}-${s.key}.jpg`,
      })
        .then((up): Outcome => {
          uploaded.current.set(s.id, up.id)
          patch(s.id, { status: "done", evidence_id: up.id })
          return "done"
        })
        .catch((e: unknown): Outcome => {
          if (e instanceof ApiError && e.status === 0) {
            patch(s.id, { status: "local" })
            return "offline"
          }
          patch(s.id, { status: "error", error: e instanceof Error ? e.message : "The upload didn't finish." })
          return "error"
        })
        .finally(() => inflight.current.delete(s.id))
      inflight.current.set(s.id, p)
      return p
    },
    [patch],
  )

  const add = React.useCallback(
    (key: string, blob: Blob, captured_at: string, via: "camera" | "upload" = "camera") => {
      const s: Shot = { id: crypto.randomUUID(), key, blob, url: URL.createObjectURL(blob), captured_at, status: "uploading", via }
      latest.current = [...latest.current, s]
      setShots((all) => [...all, s])
      void send(s)
    },
    [send],
  )

  const remove = React.useCallback((id: string) => {
    const s = latest.current.find((x) => x.id === id)
    if (s) URL.revokeObjectURL(s.url)
    latest.current = latest.current.filter((x) => x.id !== id)
    setShots((all) => all.filter((x) => x.id !== id))
  }, [])

  /*
   * Before sending: upload anything not yet uploaded (reusing an upload already running). Returns every shot with
   * whatever evidence id it has; "offline" means keep the originals and queue them.
   */
  const ensureUploaded = React.useCallback(async (): Promise<{ status: Outcome; shots: Shot[] }> => {
    let status: Outcome = "done"
    for (const s of latest.current) {
      const r = await send(s)
      if (r !== "done") {
        status = r
        break
      }
    }
    const shots = latest.current.map((s) => ({ ...s, evidence_id: uploaded.current.get(s.id) }))
    return { status, shots }
  }, [send])

  return { shots, add, remove, ensureUploaded }
}
