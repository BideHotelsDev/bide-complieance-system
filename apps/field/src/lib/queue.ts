/*
 * Checks done with no signal (EXE-06, EXE-11, §8 Offline). The form values, the device time and the original photo
 * bytes are kept in IndexedDB on the phone. When the phone is back online they send by themselves: photos first (each
 * one's evidence id is saved as soon as it is uploaded, so a dropped connection never uploads a photo twice), then the
 * check itself, marked captured offline so a life-safety check goes to verification.
 */
import * as React from "react"
import { api, ApiError, upload } from "@bide-comply/api-client"
import { clear, createStore, del, entries, set } from "idb-keyval"

import type { SubmitResult } from "./types"

const store = createStore("bide-comply-queue", "items")

export type QueuedPhoto = {
  key: string
  blob: Blob
  captured_at: string
  via?: "camera" | "upload"
  evidence_id?: string
}

export type QueuedCheck = {
  id: string
  task_id: string
  ref: string
  title: string
  property: string
  property_id: string
  values: Record<string, unknown>
  signature?: string | null
  photos: QueuedPhoto[]
  device_time: string
  lat?: number | null
  lng?: number | null
  accuracy?: number | null
  created_at: string
  status: "waiting" | "sending" | "failed"
  error?: string
}

let items: QueuedCheck[] = []
let loaded = false
const listeners = new Set<() => void>()
const sentListeners = new Set<(item: QueuedCheck, result: SubmitResult) => void>()

function emit() {
  items = [...items]
  listeners.forEach((l) => l())
}

export async function loadQueue(): Promise<void> {
  try {
    const all = await entries<string, QueuedCheck>(store)
    items = all.map(([, v]) => (v.status === "sending" ? { ...v, status: "waiting" as const } : v))
    items.sort((a, b) => a.created_at.localeCompare(b.created_at))
  } catch {
    items = []
  }
  loaded = true
  emit()
}

async function save(item: QueuedCheck) {
  const i = items.findIndex((x) => x.id === item.id)
  if (i >= 0) items[i] = item
  else items.push(item)
  emit()
  await set(item.id, item, store)
}

export async function enqueue(item: Omit<QueuedCheck, "id" | "created_at" | "status">): Promise<void> {
  await save({ ...item, id: crypto.randomUUID(), created_at: new Date().toISOString(), status: "waiting" })
}

export async function removeQueued(id: string): Promise<void> {
  items = items.filter((x) => x.id !== id)
  emit()
  await del(id, store)
}

export async function clearQueue(): Promise<void> {
  items = []
  emit()
  await clear(store)
}

export function onSent(fn: (item: QueuedCheck, result: SubmitResult) => void): () => void {
  sentListeners.add(fn)
  return () => sentListeners.delete(fn)
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useQueue(): QueuedCheck[] {
  return React.useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  )
}

export function queueLoaded(): boolean {
  return loaded
}

let syncing = false

/* Send whatever is waiting. Stops at the first sign the network is gone; a refusal from the server is kept and shown. */
export async function syncQueue(opts: { includeFailed?: boolean } = {}): Promise<void> {
  if (syncing || !navigator.onLine) return
  syncing = true
  try {
    for (const original of [...items]) {
      if (original.status === "failed" && !opts.includeFailed) continue
      let item: QueuedCheck = { ...original, status: "sending", error: undefined }
      await save(item)
      try {
        const photos: QueuedPhoto[] = []
        for (const p of item.photos) {
          if (p.evidence_id) {
            photos.push(p)
            continue
          }
          const up = await upload(p.blob, {
            captured_with: p.via ?? "camera",
            property_id: item.property_id,
            task_id: item.task_id,
            captured_at: p.captured_at,
            file_name: p.blob instanceof File ? p.blob.name : `${item.ref}-${p.key}.jpg`,
          })
          photos.push({ ...p, evidence_id: up.id })
          item = { ...item, photos: [...photos, ...item.photos.slice(photos.length)] }
          await save(item)
        }
        const grouped: Record<string, string[]> = {}
        for (const p of item.photos) (grouped[p.key] ??= []).push(p.evidence_id!)
        const res = await api.post<SubmitResult>(`/api/field/tasks/${item.task_id}/submit`, {
          values: item.values,
          signature: item.signature ?? null,
          photos: grouped,
          device_time: item.device_time,
          captured_offline: true,
          lat: item.lat ?? null,
          lng: item.lng ?? null,
          accuracy: item.accuracy ?? null,
        })
        await removeQueued(item.id)
        sentListeners.forEach((fn) => fn(item, res))
      } catch (e) {
        if (e instanceof ApiError && (e.status === 0 || e.status === 401 || e.status >= 500)) {
          await save({ ...item, status: "waiting" })
          break
        }
        await save({ ...item, status: "failed", error: e instanceof Error ? e.message : "Couldn't send." })
      }
    }
  } finally {
    syncing = false
  }
}

export function startSync(): void {
  void loadQueue().then(() => syncQueue())
  window.addEventListener("online", () => void syncQueue())
  setInterval(() => void syncQueue(), 60_000)
}

export function useOnline(): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb)
      window.addEventListener("offline", cb)
      return () => {
        window.removeEventListener("online", cb)
        window.removeEventListener("offline", cb)
      }
    },
    () => navigator.onLine,
    () => true,
  )
}
