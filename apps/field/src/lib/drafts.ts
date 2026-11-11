/*
 * Half-done checks (§8 Offline). Answers, the signature and the original photo bytes are kept in IndexedDB as they
 * change, so Back, a reload, or the phone closing the app mid-check never loses the work. A draft is removed once the
 * check is sent or saved to the queue, and drafts older than a week are dropped (the check's window has long gone).
 */
import { createStore, del, entries, get, set } from "idb-keyval"
import * as React from "react"

const store = createStore("bide-comply-drafts", "items")
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export type DraftShot = {
  key: string
  blob: Blob
  captured_at: string
  via: "camera" | "upload"
  evidence_id?: string
}

export type TaskDraft = {
  values: Record<string, unknown>
  signature: string | null
  shots: DraftShot[]
  saved_at: string
}

export async function loadDraft(taskId: string): Promise<TaskDraft | null> {
  try {
    const d = await get<TaskDraft>(taskId, store)
    if (!d) return null
    if (Date.now() - Date.parse(d.saved_at) > WEEK_MS) {
      await del(taskId, store)
      return null
    }
    return d
  } catch {
    return null
  }
}

export async function saveDraft(taskId: string, d: Omit<TaskDraft, "saved_at">): Promise<void> {
  try {
    await set(taskId, { ...d, saved_at: new Date().toISOString() }, store)
  } catch {
    // Private browsing or a full disk: the check still works, it just isn't kept.
  }
}

export async function clearDraft(taskId: string): Promise<void> {
  try {
    await del(taskId, store)
  } catch {
    // Nothing to do.
  }
}

/* Drop drafts nobody came back to. Run once at start-up. */
export async function pruneDrafts(): Promise<void> {
  try {
    const all = await entries<string, TaskDraft>(store)
    await Promise.all(
      all.filter(([, d]) => !d?.saved_at || Date.now() - Date.parse(d.saved_at) > WEEK_MS).map(([k]) => del(k, store)),
    )
  } catch {
    // Nothing to do.
  }
}

/*
 * The same for a whole form (a report, a contractor visit): `snapshot` is everything typed and picked, saved shortly
 * after each change, at once when the app goes to the background or the form is left, and put back through `restore`
 * when the form opens again. `started` false means nothing worth keeping. `finish` after sending or queueing.
 */
export function useKeptForm<T>(
  key: string | null,
  snapshot: T,
  started: boolean,
  restore: (kept: T, savedAt: string) => void,
): { loaded: boolean; finish: () => Promise<void> } {
  const [loaded, setLoaded] = React.useState(false)
  const finished = React.useRef(false)
  const restoreRef = React.useRef(restore)
  React.useEffect(() => {
    restoreRef.current = restore
  })
  React.useEffect(() => {
    if (!key) return
    let live = true
    setLoaded(false)
    void (async () => {
      try {
        const d = await get<{ data: T; saved_at: string }>(key, store)
        if (live && d && Date.now() - Date.parse(d.saved_at) <= WEEK_MS) restoreRef.current(d.data, d.saved_at)
      } catch {
        // Nothing kept, or storage unavailable.
      }
      if (live) setLoaded(true)
    })()
    return () => {
      live = false
    }
  }, [key])
  const keep = React.useRef<(() => void) | null>(null)
  React.useEffect(() => {
    keep.current =
      !key || !loaded
        ? null
        : () => {
            if (finished.current) return
            if (!started) void del(key, store).catch(() => {})
            else void set(key, { data: snapshot, saved_at: new Date().toISOString() }, store).catch(() => {})
          }
    const t = setTimeout(() => keep.current?.(), 400)
    return () => clearTimeout(t)
  }, [key, loaded, started, snapshot])
  React.useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") keep.current?.()
    }
    document.addEventListener("visibilitychange", hidden)
    return () => {
      document.removeEventListener("visibilitychange", hidden)
      keep.current?.()
    }
  }, [])
  const finish = React.useCallback(async () => {
    finished.current = true
    if (key) await del(key, store).catch(() => {})
  }, [key])
  return { loaded, finish }
}
