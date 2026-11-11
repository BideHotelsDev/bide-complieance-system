/*
 * Half-done checks (§8 Offline). Answers, the signature and the original photo bytes are kept in IndexedDB as they
 * change, so Back, a reload, or the phone closing the app mid-check never loses the work. A draft is removed once the
 * check is sent or saved to the queue, and drafts older than a week are dropped (the check's window has long gone).
 */
import { createStore, del, entries, get, set } from "idb-keyval"

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
    await Promise.all(all.filter(([, d]) => Date.now() - Date.parse(d.saved_at) > WEEK_MS).map(([k]) => del(k, store)))
  } catch {
    // Nothing to do.
  }
}
