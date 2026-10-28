/*
 * The API client both web apps use. Cookie sessions (HttpOnly) with a 15-minute access token: when the API answers
 * "access_expired", the client refreshes once and retries. Every mutation carries X-Requested-With so a cross-site
 * form can't make one (CSRF, §9.5). Errors come back as ApiError with the server's plain-English message.
 */

export class ApiError extends Error {
  status: number
  code: string
  data: Record<string, unknown>
  constructor(status: number, code: string, message: string, data: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.data = data
  }
}

type Opts = { app?: "web" | "field"; onSignedOut?: (code: string) => void }
let opts: Opts = {}
export function configure(o: Opts): void {
  opts = { ...opts, ...o }
}

let refreshing: Promise<boolean> | null = null
async function refresh(): Promise<boolean> {
  refreshing ??= fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-Requested-With": "bide-comply" },
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => (refreshing = null), 0)
    })
  return refreshing
}

export type Query = Record<string, string | number | boolean | null | undefined | (string | number)[]>

export function qs(q?: Query): string {
  if (!q) return ""
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)))
    else p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ""
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "bide-comply", "X-Bide-App": opts.app ?? "web" }
  let payload: BodyInit | undefined
  if (body instanceof FormData || body instanceof Blob) payload = body
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json"
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" })
  } catch {
    throw new ApiError(0, "offline", "Couldn't reach bide Comply. Check your connection.")
  }
  if (res.status === 401) {
    const data = (await res.json().catch(() => ({}))) as { code?: string; message?: string }
    if (data.code === "access_expired" && !retried && (await refresh())) return request<T>(method, path, body, true)
    opts.onSignedOut?.(data.code ?? "signed_out")
    throw new ApiError(401, data.code ?? "signed_out", data.message ?? "Please sign in.")
  }
  const type = res.headers.get("content-type") ?? ""
  if (!res.ok) {
    const data = (type.includes("json") ? await res.json().catch(() => ({})) : {}) as Record<string, unknown>
    throw new ApiError(
      res.status,
      String(data.code ?? "error"),
      String(data.message ?? "Something went wrong. Nothing was saved. Try again."),
      data,
    )
  }
  if (type.includes("json")) return (await res.json()) as T
  return (await res.blob()) as unknown as T
}

export const api = {
  get: <T>(path: string, q?: Query) => request<T>("GET", path + qs(q)),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
  blob: (path: string, body: unknown) => request<Blob>("POST", path, body),
}

/* Uploads: ask for a slot, PUT the bytes to the signed URL, then confirm (§9.4) */
export type Uploaded = {
  id: string
  kind: string
  file_name: string
  url: string
  thumb_url: string | null
  sha256: string
}

export async function upload(
  file: Blob,
  o: {
    captured_with: "camera" | "upload"
    property_id?: string | null
    task_id?: string | null
    file_name?: string
    captured_at?: string
    purpose?: "evidence" | "logo"
  },
): Promise<Uploaded> {
  const slot = await api.post<{ evidence_id: string; upload: { method: string; url: string; headers?: Record<string, string>; fields?: Record<string, string> } }>(
    "/api/uploads",
    {
      content_type: file.type,
      size: file.size,
      file_name: o.file_name ?? (file instanceof File ? file.name : undefined),
      captured_with: o.captured_with,
      property_id: o.property_id ?? null,
      task_id: o.task_id ?? null,
      captured_at: o.captured_at,
      purpose: o.purpose ?? "evidence",
    },
  )
  const u = slot.upload
  let res: Response
  if (u.method === "POST" && u.fields) {
    const fd = new FormData()
    Object.entries(u.fields).forEach(([k, v]) => fd.append(k, v))
    fd.append("file", file)
    res = await fetch(u.url, { method: "POST", body: fd })
  } else {
    res = await fetch(u.url, { method: "PUT", body: file, headers: u.headers })
  }
  if (!res.ok) throw new ApiError(res.status, "upload", "The upload didn't finish. Try again.")
  return api.post<Uploaded>(`/api/uploads/${slot.evidence_id}/complete`, { task_id: o.task_id ?? null })
}

export async function download(path: string, body: unknown, fileName: string): Promise<void> {
  const blob = await api.blob(path, body)
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
