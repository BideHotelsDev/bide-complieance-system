/*
 * Phone notifications (Me › Phone notifications, PRD §7 Channels). The phone subscribes with the API's VAPID public
 * key and the subscription is saved against the person (POST /api/push/subscribe); the worker sends to it. Without a
 * key on the server, or on a phone that can't do web push (iOS only does it once the app is on the Home Screen), the
 * in-app inbox still gets everything and Me says why the phone won't buzz.
 */
import { api } from "@bide-comply/api-client"

import { appPath } from "./base"

export type PushState = "on" | "off" | "denied" | "no-key" | "unsupported" | "no-worker"

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4)
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/* The app's service worker, if one is running (production builds only; none in `vite dev`). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null
  const reg = await navigator.serviceWorker.getRegistration(appPath("/")).catch(() => undefined)
  if (!reg) return null
  return reg.active ? reg : await Promise.race([navigator.serviceWorker.ready, wait(4000)])
}

function wait(ms: number): Promise<null> {
  return new Promise((r) => setTimeout(() => r(null), ms))
}

let keyCache: Promise<string | null> | null = null
function publicKey(): Promise<string | null> {
  keyCache ??= api
    .get<{ public_key: string | null }>("/api/push/key")
    .then((r) => r.public_key)
    .catch(() => {
      keyCache = null
      return null
    })
  return keyCache
}

async function save(sub: PushSubscription): Promise<void> {
  const j = sub.toJSON()
  await api.post("/api/push/subscribe", { endpoint: j.endpoint, keys: j.keys ?? {} })
}

/* Where this phone stands, without asking the person anything. */
export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported"
  if (Notification.permission === "denied") return "denied"
  if (!(await publicKey())) return "no-key"
  const reg = await registration()
  if (!reg) return "no-worker"
  return (await reg.pushManager.getSubscription()) ? "on" : "off"
}

/* Ask for permission (only ever from a tap) and subscribe this phone. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return "unsupported"
  const key = await publicKey()
  if (!key) return "no-key"
  const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission
  if (perm !== "granted") return perm === "denied" ? "denied" : "off"
  const reg = await registration()
  if (!reg) return "no-worker"
  let sub = await reg.pushManager.getSubscription()
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) })
  await save(sub)
  return "on"
}

/* Stop this phone getting pushes (turning the setting off, or signing out). */
export async function disablePush(): Promise<void> {
  const reg = await registration().catch(() => null)
  const sub = await reg?.pushManager.getSubscription().catch(() => null)
  if (!sub) return
  const j = sub.toJSON()
  await api.post("/api/push/unsubscribe", { endpoint: j.endpoint, keys: j.keys ?? {} }).catch(() => undefined)
  await sub.unsubscribe().catch(() => false)
}

/* On start: a phone that already allowed notifications re-saves its subscription (it can change, or the person may
   have signed in again). Never prompts. */
export async function refreshPush(): Promise<void> {
  if (!supported() || Notification.permission !== "granted") return
  const reg = await registration()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) await save(sub).catch(() => undefined)
}
