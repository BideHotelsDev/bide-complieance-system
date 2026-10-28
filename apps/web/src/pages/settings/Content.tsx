/*
 * Messages and wording (CMS-17, design: Content). Edit the words; the {details} fill in by themselves. Edits save as
 * a draft as you type (with a live preview and tone check) and go live for everyone with Publish changes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, X } from "lucide-react"
import * as React from "react"

import { api, type ApiError } from "@bide-comply/api-client"
import { ErrorState, Mark, NoPermission, PageHeader, Skeleton } from "@bide-comply/ui/components/page"
import { Pill } from "@bide-comply/ui/components/status"
import { toast } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { errText } from "../../features/settings-b/ui"
import { useParams } from "../../lib/params"
import { useMe } from "../../lib/session"

type Item = { key: string; name: string; channels: string[]; edited: boolean }
type Group = { key: string; label: string; items: Item[] }
type Message = {
  key: string
  name: string
  channels: string[]
  body: string
  published_body: string
  edited: boolean
  placeholders: string[]
  preview: string
  short: string | null
  tone: { rule: string; ok: boolean }[]
  can_edit: boolean
}

// The order people think in (design: Content), not alphabetical.
const ORDER = [
  "check_due_soon",
  "check_overdue",
  "class_a_failure",
  "certificate_expiring",
  "monday_digest",
  "failed_result",
  "empty_overdue",
  "privacy_notice",
  "tour",
]
const rank = (k: string) => (ORDER.indexOf(k) === -1 ? 99 : ORDER.indexOf(k))
const CH: Record<string, string> = { app: "App", slack: "Slack", email: "email", phone: "phone", push: "push" }
const channelCaption = (cs: string[]) => cs.map((c) => CH[c] ?? c).join(", ")
const OPEN_LABEL: Record<string, string> = {
  certificate_expiring: "Open certificate",
  monday_digest: "Open dashboard",
}

export function ContentPage() {
  const me = useMe()
  const qc = useQueryClient()
  const [params, set] = useParams()
  const list = useQuery<{ groups: Group[] }, ApiError>({
    queryKey: ["settings", "content"],
    queryFn: () => api.get("/api/settings/content"),
  })
  const groups = React.useMemo(
    () =>
      (list.data?.groups ?? []).map((g) => ({ ...g, items: [...g.items].sort((a, b) => rank(a.key) - rank(b.key)) })),
    [list.data],
  )
  const all = groups.flatMap((g) => g.items)
  const selected = params.key && all.some((i) => i.key === params.key) ? params.key : (all[0]?.key ?? null)
  const anyEdited = all.some((i) => i.edited)

  const msg = useQuery<Message, ApiError>({
    queryKey: ["settings", "content", selected],
    queryFn: () => api.get<Message>(`/api/settings/content/${selected}`),
    enabled: !!selected,
  })

  const publish = useMutation<{ published: number }, ApiError>({
    mutationFn: () => api.post("/api/settings/content/publish"),
    onSuccess: (r) => {
      toast.success(
        r.published === 1
          ? "Published 1 change. Everyone sees it now."
          : `Published ${r.published} changes. Everyone sees them now.`,
      )
      void qc.invalidateQueries({ queryKey: ["settings", "content"] })
    },
    onError: (e) => toast.error(errText(e)),
  })
  const reset = useMutation<unknown, ApiError, string>({
    mutationFn: (key) => api.post(`/api/settings/content/${key}/reset`),
    onSuccess: (_r, key) => {
      toast.success("Back to the default wording. Publish to make it live.")
      void qc.invalidateQueries({ queryKey: ["settings", "content"] })
      void qc.invalidateQueries({ queryKey: ["settings", "content", key] })
    },
    onError: (e) => toast.error(errText(e)),
  })

  if (me.data && !me.data.can["settings.view"]) return <NoPermission />
  const canEdit = !!(me.data?.can["content.edit"] ?? msg.data?.can_edit)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Messages and wording"
        subtitle="Edit the words. The details fill in by themselves."
        actions={
          canEdit && (
            <>
              <button
                type="button"
                disabled={!selected || reset.isPending}
                onClick={() => selected && reset.mutate(selected)}
                className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-3.5 text-[13.5px] font-medium hover:bg-hover disabled:opacity-40"
              >
                Reset to default
              </button>
              <button
                type="button"
                disabled={!anyEdited || publish.isPending}
                onClick={() => publish.mutate()}
                className="inline-flex h-9 items-center rounded-md bg-primary px-3.5 text-[13.5px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                {publish.isPending ? "Publishing…" : "Publish changes"}
              </button>
            </>
          )
        }
      />

      {list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_320px]">
          <nav aria-label="Messages" className="flex flex-col">
            {!list.data && (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 7 }).map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            )}
            {groups.map((g) => (
              <div key={g.key} className="mb-3">
                <div className="px-3.5 pt-1 pb-2 text-[12.5px] font-medium text-muted-foreground">{g.label}</div>
                {g.items.map((it) => (
                  <a
                    key={it.key}
                    href={`?key=${it.key}`}
                    aria-current={it.key === selected ? "page" : undefined}
                    onClick={(e) => {
                      e.preventDefault()
                      set({ key: it.key })
                    }}
                    className={cn(
                      "block rounded-lg border px-3.5 py-2.5 text-foreground no-underline",
                      it.key === selected ? "border-divider bg-surface" : "border-transparent hover:bg-hover",
                    )}
                  >
                    <span className="flex items-center gap-2 text-[14px] font-medium">
                      {it.name}
                      {it.edited && (
                        <span className="size-1.5 rounded-full bg-st-amber" aria-label="Edited, not published" />
                      )}
                    </span>
                    {it.channels.length > 0 && (
                      <span className="block text-[12.5px] text-muted-foreground">
                        {channelCaption(it.channels).replace(/^./, (c) => c.toUpperCase())}
                      </span>
                    )}
                  </a>
                ))}
              </div>
            ))}
          </nav>

          {msg.isError ? (
            <div className="rounded-[10px] border border-divider bg-surface xl:col-span-2">
              <ErrorState message={msg.error.message} onRetry={() => void msg.refetch()} />
            </div>
          ) : !msg.data ? (
            <>
              <Skeleton className="h-80" />
              <Skeleton className="hidden h-60 xl:block" />
            </>
          ) : (
            <Editor key={msg.data.key} msg={msg.data} canEdit={canEdit} />
          )}
        </div>
      )}
    </div>
  )
}

function Editor({ msg, canEdit }: { msg: Message; canEdit: boolean }) {
  const qc = useQueryClient()
  const [body, setBody] = React.useState(msg.body)
  const [preview, setPreview] = React.useState({ text: msg.preview, tone: msg.tone })
  const [edited, setEdited] = React.useState(msg.edited)
  const [state, setState] = React.useState<"idle" | "saving" | "saved" | "error">("idle")
  const [error, setError] = React.useState<string | null>(null)
  const saved = React.useRef(msg.body)
  const ta = React.useRef<HTMLTextAreaElement>(null)
  const backdrop = React.useRef<HTMLDivElement>(null)

  // A new server copy (after Reset or Publish) replaces what's on screen.
  React.useEffect(() => {
    setBody(msg.body)
    saved.current = msg.body
    setPreview({ text: msg.preview, tone: msg.tone })
    setEdited(msg.edited)
  }, [msg])

  const doSave = React.useCallback(
    async (text: string) => {
      setState("saving")
      try {
        const r = await api.put<{ preview: string; tone: Message["tone"] }>(`/api/settings/content/${msg.key}`, {
          body: text,
        })
        saved.current = text
        setPreview({ text: r.preview, tone: r.tone })
        setError(null)
        setState("saved")
        if (!edited) {
          setEdited(true)
          void qc.invalidateQueries({ queryKey: ["settings", "content"], exact: true })
        }
      } catch (e) {
        setError(errText(e))
        setState("error")
      }
    },
    [msg.key, edited, qc],
  )

  // Saves as a draft about half a second after typing stops.
  const latest = React.useRef({ body, doSave })
  React.useEffect(() => {
    latest.current = { body, doSave }
  }, [body, doSave])
  React.useEffect(() => {
    if (!canEdit || body === saved.current) return
    const t = setTimeout(() => void doSave(body), 600)
    return () => clearTimeout(t)
  }, [body, canEdit, doSave])
  // Leaving this message mid-edit still keeps the words.
  React.useEffect(
    () => () => {
      const { body: b, doSave: s } = latest.current
      if (canEdit && b !== saved.current) void s(b)
    },
    [canEdit],
  )

  // The box grows with the words, so the highlighted details always line up with the text.
  React.useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight + 2}px`
  }, [body])

  const insert = (name: string) => {
    const el = ta.current
    const token = `{${name}}`
    const start = el?.selectionStart ?? body.length
    const end = el?.selectionEnd ?? body.length
    const next = body.slice(0, start) + token + body.slice(end)
    setBody(next)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const parts = body.split(/(\{[a-z_]+\})/g)
  const allOk = preview.tone.every((t) => t.ok)
  const isAlert = msg.channels.length > 0
  const [pushTitle, ...pushRest] = (msg.short ?? "").split(" · ")

  return (
    <>
      <section aria-label="Editor" className="min-w-0 rounded-[10px] border border-divider bg-surface">
        <div className="flex items-center gap-3 border-b border-divider px-[18px] py-3.5">
          <h2 className="m-0 text-[15px] font-semibold">{msg.name}</h2>
          <span className="ml-auto flex items-center gap-2">
            <span aria-live="polite" className="text-[12px] text-subtle">
              {state === "saving" ? "Saving…" : state === "saved" ? "Draft saved" : ""}
            </span>
            {edited && <Pill tone="amber">Edited · not published</Pill>}
          </span>
        </div>
        <div className="flex flex-col gap-4 p-[18px]">
          <div>
            <label htmlFor="message-body" className="mb-1.5 block text-[13px] font-medium">
              Message
            </label>
            <div
              className={cn(
                "relative rounded-lg border bg-surface focus-within:outline-2 focus-within:outline-focus",
                error ? "border-st-red" : "border-border",
              )}
            >
              <div
                ref={backdrop}
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-2.5 text-[14px] leading-6 break-words whitespace-pre-wrap text-foreground"
              >
                {parts.map((p, i) =>
                  /^\{[a-z_]+\}$/.test(p) ? (
                    <span
                      key={i}
                      className={cn(
                        "rounded-[4px]",
                        msg.placeholders.includes(p.slice(1, -1))
                          ? "bg-st-blue-bg text-st-blue shadow-[0_0_0_2px_var(--c-blue-bg)]"
                          : "bg-st-red-bg text-st-red shadow-[0_0_0_2px_var(--c-red-bg)]",
                      )}
                    >
                      {p}
                    </span>
                  ) : (
                    <React.Fragment key={i}>{p}</React.Fragment>
                  ),
                )}
                {"\n"}
              </div>
              <textarea
                id="message-body"
                ref={ta}
                value={body}
                readOnly={!canEdit}
                rows={4}
                spellCheck
                aria-invalid={!!error}
                aria-describedby={error ? "message-error" : undefined}
                onChange={(e) => setBody(e.target.value)}
                onScroll={(e) => {
                  if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop
                }}
                className="relative block min-h-[96px] w-full resize-none overflow-hidden bg-transparent px-3 py-2.5 text-[14px] leading-6 break-words text-transparent caret-[var(--c-foreground)] outline-none selection:bg-st-blue/25"
              />
            </div>
            {error && (
              <p id="message-error" role="alert" className="m-0 mt-1.5 text-[13px] text-st-red">
                {error}
              </p>
            )}
          </div>

          {canEdit && msg.placeholders.length > 0 && (
            <div>
              <div className="mb-1.5 text-[13px] font-medium">Insert a detail</div>
              <div className="flex flex-wrap gap-1.5">
                {msg.placeholders.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => insert(p)}
                    aria-label={`Insert ${p.replace(/_/g, " ")}`}
                    className="inline-flex h-[26px] items-center rounded-md bg-st-blue-bg px-2 font-mono text-[12px] text-st-blue hover:opacity-80"
                  >
                    {`{${p}}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            role="status"
            className={cn(
              "rounded-lg px-3.5 py-3",
              allOk ? "bg-st-green-bg text-st-green" : "bg-st-amber-bg text-st-amber",
            )}
          >
            <div className="text-[14px] font-semibold">
              {allOk ? "Tone check: looks good" : "Tone check: worth another look"}
            </div>
            <ul className="m-0 mt-1 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[13px]">
              {preview.tone.map((t) => (
                <li key={t.rule} className="inline-flex items-center gap-1">
                  {t.ok ? <Check aria-hidden className="size-3.5" /> : <X aria-hidden className="size-3.5" />}
                  <span>
                    {t.rule}
                    <span className="sr-only">{t.ok ? ": pass" : ": fix this"}</span>
                  </span>
                  {!t.ok && <span className="font-semibold">· fix</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <aside aria-label="Preview" className="flex min-w-0 flex-col gap-3 lg:col-start-2 xl:col-start-auto">
        <div className="text-[13px] font-medium text-ink2">Preview with a real example</div>
        <div className="rounded-[10px] border border-divider bg-surface p-3.5">
          <div className="flex gap-2.5">
            <Mark size={22} className="mt-0.5 rounded-[5px] text-[12px]" />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px]">
                <span className="font-semibold">bide Comply</span>{" "}
                <span className="text-[12px] text-muted-foreground">{isAlert ? "Slack · 09:00" : "On screen"}</span>
              </div>
              <p className="m-0 mt-0.5 text-[13.5px] break-words whitespace-pre-wrap">{preview.text}</p>
              {isAlert && (
                <span className="mt-2 inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[13px] font-medium">
                  {OPEN_LABEL[msg.key] ?? "Open check"}
                </span>
              )}
            </div>
          </div>
        </div>
        {isAlert && msg.short && (
          <>
            <div className="rounded-[10px] border border-divider bg-sidebar p-3.5">
              <div className="flex gap-2.5">
                <Mark size={22} className="mt-0.5 rounded-[5px] text-[12px]" />
                <div className="min-w-0 text-[13px]">
                  <div className="font-semibold">{pushTitle}</div>
                  {pushRest.length > 0 && <div>{pushRest.join(" · ")}</div>}
                </div>
              </div>
            </div>
            <p className="m-0 text-[12.5px] text-muted-foreground">
              Push notifications use a shorter version automatically.
            </p>
          </>
        )}
      </aside>
    </>
  )
}
