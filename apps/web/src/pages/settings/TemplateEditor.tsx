/*
 * Settings › Compliance library › Check form builder (design: TemplateEditor, CMS-02..04). Three columns: the rules
 * for when and how the check runs, the ordered form staff answer, and a live preview of the staff app. Every edit
 * autosaves to a draft version; nothing changes for staff until it is published, and publishing changes future tasks
 * only.
 */
import * as React from "react"
import { Link, useNavigate, useParams as useRouteParams } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, History, Plus, X } from "lucide-react"
import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Segmented } from "@bide-comply/ui/components/filter-bar"
import { ErrorState, LoadingPage, NoPermission } from "@bide-comply/ui/components/page"
import { Popover, PopoverContent, PopoverTrigger } from "@bide-comply/ui/components/popover"
import { Pill } from "@bide-comply/ui/components/status"
import { Switch } from "@bide-comply/ui/components/switch"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import {
  AddFieldMenu,
  FieldCard,
  newField,
  PhonePreview,
  type FieldType,
  type FormField,
} from "../../features/settings-a/form-builder"
import { ArchiveDialog, useLibraryOptions } from "../../features/settings-a/library"
import { ActionDialog, errMsg, humanise, Labeled, NativeSelect, TextInput } from "../../features/settings-a/ui"
import { fmtDate, fmtTime, plural } from "../../lib/format"
import { useProperty } from "../../lib/property"
import { useMe } from "../../lib/session"

type Cond = { feature?: string; jurisdiction?: string[]; licence_regime?: string }
type Rule = { all?: Cond[]; any?: Cond[] }
type Settings = {
  name: string
  domain_id: string
  class: "A" | "B" | "C"
  kind: string
  default_frequency: string
  warning_days: number | null
  late_rule: "late" | "missed"
  verification: "none" | "always" | "sample"
  sample_rate: number
  legal_basis: string | null
  applies_to: Rule | null
  geofence_required: boolean
  qr_required: boolean
  [k: string]: unknown
}
type Version = {
  version: number
  status: string
  published_at: string | null
  by: string | null
  note: string | null
  tasks: number
}
type Detail = {
  id: string
  status: string
  current_version: number
  draft_version: number | null
  editing_version: number
  autosaved_at: string | null
  settings: Settings
  form: FormField[]
  used_at: number
  versions: Version[]
  can_edit: boolean
}

export function TemplateEditorPage() {
  const { id } = useRouteParams({ strict: false }) as { id: string }
  const q = useQuery({ queryKey: ["template", id], queryFn: () => api.get<Detail>(`/api/library/${id}`) })
  if (q.error instanceof ApiError && q.error.status === 403) return <NoPermission />
  if (q.error)
    return (
      <ErrorState
        title={q.error instanceof ApiError && q.error.status === 404 ? "This template doesn't exist" : undefined}
        message={errMsg(q.error)}
        onRetry={() => void q.refetch()}
      />
    )
  if (!q.data) return <LoadingPage />
  return <Editor key={`${id}`} detail={q.data} refetch={async () => (await q.refetch()).data} />
}

function Editor({ detail, refetch }: { detail: Detail; refetch: () => Promise<Detail | undefined> }) {
  const me = useMe()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { property } = useProperty()
  const opts = useLibraryOptions()
  const canEdit = detail.can_edit && !!me.data?.can["library.edit"] && detail.status !== "archived"

  const [settings, setSettings] = React.useState<Settings>(detail.settings)
  const [form, setForm] = React.useState<FormField[]>(detail.form)
  const [draftVersion, setDraftVersion] = React.useState<number | null>(detail.draft_version)
  const [savedAt, setSavedAt] = React.useState<string | null>(detail.autosaved_at)
  const [gen, setGen] = React.useState(0) // bumps on reset so uncontrolled inputs remount
  const [openKey, setOpenKey] = React.useState<string | null>(null)
  const [dragFrom, setDragFrom] = React.useState<number | null>(null)
  const [dragOver, setDragOver] = React.useState<number | null>(null)
  const [publishing, setPublishing] = React.useState(false)
  const [discarding, setDiscarding] = React.useState(false)
  const [archiving, setArchiving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [dirty, setDirty] = React.useState(false)

  // Autosave: changes collect in `pending` and go to the draft about 800 ms after the last edit.
  const pending = React.useRef<{ settings: Partial<Settings>; form: FormField[] | null } | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const save = useMutation({
    mutationFn: (body: { settings: Partial<Settings>; form: FormField[] | null }) =>
      api.put<{ version: number; autosaved_at: string }>(`/api/library/${detail.id}/draft`, {
        settings: body.settings,
        form: body.form ?? undefined,
      }),
    onSuccess: (r) => {
      setDraftVersion(r.version)
      setSavedAt(r.autosaved_at)
      setSaveError(null)
      void qc.invalidateQueries({ queryKey: ["library"] })
    },
    onError: (e) => setSaveError(errMsg(e)),
  })
  const flush = React.useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const body = pending.current
    pending.current = null
    setDirty(false)
    if (body) await save.mutateAsync(body)
  }, [save])
  const schedule = (patch: { settings?: Partial<Settings>; form?: FormField[] }) => {
    const cur = pending.current ?? { settings: {}, form: null }
    pending.current = {
      settings: { ...cur.settings, ...(patch.settings ?? {}) },
      form: patch.form ?? cur.form,
    }
    setDirty(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush().catch(() => {}), 800)
  }
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      const body = pending.current
      // Leaving the page saves what is left rather than dropping it.
      if (body)
        void api
          .put(`/api/library/${detail.id}/draft`, { settings: body.settings, form: body.form ?? undefined })
          .catch(() => {})
    },
    [detail.id],
  )

  const setS = (patch: Partial<Settings>) => {
    if (!canEdit) return
    setSettings((s) => ({ ...s, ...patch }))
    schedule({ settings: patch })
  }
  const setF = (next: FormField[]) => {
    if (!canEdit) return
    setForm(next)
    schedule({ form: next })
  }
  const patchField = (i: number, patch: Partial<FormField>) => {
    const next = form.map((f, j) => {
      if (j !== i) return f
      const merged: FormField = { ...f, ...patch }
      for (const k of Object.keys(patch) as (keyof FormField)[]) if (patch[k] === undefined) delete merged[k]
      return merged
    })
    setF(next)
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= form.length || from === to) return
    const next = [...form]
    const [f] = next.splice(from, 1)
    next.splice(to, 0, f)
    setF(next)
  }
  const add = (t: FieldType) => {
    const f = newField(t, form)
    setF([...form, f])
    setOpenKey(f.key)
  }

  const reset = (d: Detail) => {
    setSettings(d.settings)
    setForm(d.form)
    setDraftVersion(d.draft_version)
    setSavedAt(d.autosaved_at)
    setGen((g) => g + 1)
    setOpenKey(null)
  }

  const publish = useMutation({
    mutationFn: async (note: string) => {
      await flush()
      return api.post<{ version: number }>(`/api/library/${detail.id}/publish`, { note: note || null })
    },
    onSuccess: async (r) => {
      setPublishing(false)
      toast(`Published v${r.version}. Future tasks use it; past records keep their form.`)
      void qc.invalidateQueries({ queryKey: ["library"] })
      const d = await refetch()
      if (d) reset(d)
    },
    onError: (e) => toastError(errMsg(e)),
  })
  const discard = useMutation({
    mutationFn: async () => {
      if (timer.current) clearTimeout(timer.current)
      pending.current = null
      setDirty(false)
      return api.del(`/api/library/${detail.id}/draft`)
    },
    onSuccess: async () => {
      setDiscarding(false)
      toast("Draft discarded. The live version is unchanged.")
      void qc.invalidateQueries({ queryKey: ["library"] })
      const d = await refetch()
      if (d) reset(d)
    },
    onError: (e) => toastError(errMsg(e)),
  })

  const o = opts.data
  const freqLabel =
    o?.frequencies.find((f) => f.key === settings.default_frequency)?.label ?? settings.default_frequency
  const defaultWindow = o?.windows[settings.default_frequency] ?? null
  const days = (n: number) => (n === 0 ? "Same day" : plural(n, "day"))
  const nextVersion = draftVersion ?? Math.max(...detail.versions.map((v) => v.version), detail.current_version) + 1
  const hasDraft = draftVersion != null
  const saving = save.isPending || dirty

  return (
    <div className="-mx-4 -my-5 flex min-h-[calc(100vh)] flex-col md:-mx-7 md:-my-6">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-divider bg-surface px-4 py-2.5 md:px-5">
        <Button variant="outline" size="icon-sm" asChild>
          <Link to="/settings/library" aria-label="Back to library">
            <ArrowLeft />
          </Link>
        </Button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[14px]">
          <Link to="/settings/library" className="text-muted-foreground no-underline hover:text-foreground">
            Library
          </Link>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <h1 className="m-0 truncate text-[14px] font-semibold">{settings.name || "Untitled template"}</h1>
        </nav>
        {detail.status === "archived" ? (
          <Pill tone="grey">Archived</Pill>
        ) : hasDraft ? (
          <Pill tone="amber">v{draftVersion} draft</Pill>
        ) : (
          <Pill tone="grey">v{detail.current_version} live</Pill>
        )}
        {detail.status === "proposed" && <Pill tone="outline">Proposed addition</Pill>}
        <span aria-live="polite" className={cn("text-[12.5px]", saveError ? "text-st-red" : "text-muted-foreground")}>
          {saveError
            ? `Not saved: ${saveError}`
            : saving
              ? "Saving…"
              : savedAt && hasDraft
                ? `Autosaved ${fmtTime(savedAt)}`
                : canEdit
                  ? "Changes save as a draft"
                  : "Read only"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <VersionHistory versions={detail.versions} current={detail.current_version} />
          {canEdit && (
            <>
              <Button variant="outline" disabled={!hasDraft} onClick={() => setDiscarding(true)}>
                Discard draft
              </Button>
              <Button disabled={!hasDraft || saving || !!saveError} onClick={() => setPublishing(true)}>
                Publish v{nextVersion}
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_320px]">
        {/* Settings */}
        <aside
          aria-label="Template settings"
          className="border-b border-divider bg-surface p-4 lg:border-r lg:border-b-0"
        >
          <h2 className="m-0 mb-3 text-[15px] font-semibold">Settings</h2>
          <fieldset disabled={!canEdit} className="m-0 flex flex-col gap-3.5 border-0 p-0">
            <Labeled label="Name" htmlFor="t-name">
              <TextInput
                id="t-name"
                value={settings.name}
                aria-invalid={!settings.name.trim() || undefined}
                onChange={(e) => setS({ name: e.target.value })}
              />
            </Labeled>
            <div className="grid grid-cols-2 gap-2.5">
              <Labeled label="Domain" htmlFor="t-domain">
                <NativeSelect
                  id="t-domain"
                  value={settings.domain_id}
                  onChange={(e) => setS({ domain_id: e.target.value })}
                  options={(o?.domains ?? []).map((d) => ({ value: d.id, label: d.name }))}
                />
              </Labeled>
              <Labeled label="Type" htmlFor="t-kind">
                <NativeSelect
                  id="t-kind"
                  value={settings.kind}
                  onChange={(e) => setS({ kind: e.target.value })}
                  options={(o?.kinds ?? []).map((k) => ({ value: k.key, label: k.label }))}
                />
              </Labeled>
            </div>
            <Labeled label="Class">
              <div
                className={cn(
                  "[&>div]:flex [&>div]:w-full [&_button]:flex-auto [&_button]:justify-center [&_button]:px-1.5 [&_button]:whitespace-nowrap",
                  !canEdit && "pointer-events-none opacity-70",
                )}
              >
                <Segmented
                  label="Class"
                  size="sm"
                  value={settings.class}
                  onChange={(v) => setS({ class: v })}
                  options={[
                    { value: "A", label: "A · Life safety" },
                    { value: "B", label: "B · Statutory" },
                    { value: "C", label: "C" },
                  ]}
                />
              </div>
            </Labeled>
            <div className="grid grid-cols-2 gap-2.5">
              <Labeled label="Default frequency" htmlFor="t-freq">
                <NativeSelect
                  id="t-freq"
                  value={settings.default_frequency}
                  onChange={(e) => setS({ default_frequency: e.target.value })}
                  options={(o?.frequencies ?? []).map((f) => ({ value: f.key, label: f.label }))}
                />
              </Labeled>
              <Labeled label="Amber window" htmlFor="t-window">
                <NativeSelect
                  id="t-window"
                  value={settings.warning_days == null ? "" : String(settings.warning_days)}
                  onChange={(e) => setS({ warning_days: e.target.value === "" ? null : Number(e.target.value) })}
                  options={[
                    { value: "", label: defaultWindow == null ? "Default" : days(defaultWindow) },
                    ...[0, 1, 2, 3, 5, 7, 14, 30, 60, 90]
                      .filter((n) => n !== defaultWindow)
                      .map((n) => ({ value: String(n), label: days(n) })),
                  ]}
                />
              </Labeled>
            </div>
            <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
              <legend className="mb-1.5 text-[12.5px] font-medium text-ink2">When the window closes</legend>
              {(
                [
                  ["late", "Completable late", "Stays Overdue and escalates until done"],
                  ["missed", "Closes as Missed", "For time-bound records, e.g. daily temperatures"],
                ] as const
              ).map(([v, label, help]) => (
                <label
                  key={v}
                  className={cn(
                    "flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2",
                    settings.late_rule === v ? "border-primary" : "border-border",
                  )}
                >
                  <input
                    type="radio"
                    name="late_rule"
                    className="mt-1 size-4 accent-[var(--c-primary)]"
                    checked={settings.late_rule === v}
                    onChange={() => setS({ late_rule: v })}
                  />
                  <span>
                    <span className="block text-[13.5px] font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">{help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <Labeled label="Verification" htmlFor="t-verify">
              <NativeSelect
                id="t-verify"
                value={settings.verification === "sample" ? `sample:${settings.sample_rate}` : settings.verification}
                onChange={(e) => {
                  const [v, n] = e.target.value.split(":")
                  setS(
                    v === "sample"
                      ? { verification: "sample", sample_rate: Number(n) }
                      : { verification: v as Settings["verification"] },
                  )
                }}
                options={[
                  { value: "none", label: "None" },
                  { value: "always", label: "Always verify" },
                  ...[5, 10, 20, settings.sample_rate]
                    .filter((n, i, a) => a.indexOf(n) === i)
                    .sort((a, b) => a - b)
                    .map((n) => ({ value: `sample:${n}`, label: `Spot-check 1 in ${n}` })),
                ]}
              />
            </Labeled>
            <Labeled label="Legal basis and standard" htmlFor="t-legal">
              <TextInput
                id="t-legal"
                value={settings.legal_basis ?? ""}
                onChange={(e) => setS({ legal_basis: e.target.value || null })}
              />
            </Labeled>
            <AppliesTo
              rule={settings.applies_to}
              features={o?.features ?? []}
              disabled={!canEdit}
              onChange={(r) => setS({ applies_to: r })}
            />
            <div className="flex flex-col gap-2.5 border-t border-divider pt-3.5">
              <label className="flex items-center justify-between gap-3 text-[13.5px]">
                Location check (geofence)
                <Switch
                  aria-label="Geofence required"
                  checked={settings.geofence_required}
                  onCheckedChange={(v) => setS({ geofence_required: v })}
                />
              </label>
              <div className="flex items-center justify-between gap-3 text-[13.5px] text-muted-foreground">
                <span className="flex items-center gap-2">
                  QR scan at location{" "}
                  <Pill tone="grey" title="Planned for phase 2">
                    P2
                  </Pill>
                </span>
                <Switch aria-label="QR scan required" checked={false} disabled />
              </div>
            </div>
            {canEdit && detail.status !== "archived" && (
              <button
                type="button"
                onClick={() => setArchiving(true)}
                className="mt-1 self-start text-[12.5px] text-st-red hover:underline"
              >
                Archive this template…
              </button>
            )}
          </fieldset>
        </aside>

        {/* Form builder */}
        <section aria-labelledby="form-h" className="flex flex-col gap-2.5 bg-background p-4 md:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="form-h" className="m-0 text-[15px] font-semibold">
              Form · {plural(form.length, "field")}
            </h2>
            <span className="text-[12.5px] text-muted-foreground">Drag to reorder. Required fields are marked.</span>
          </div>
          <div
            className="flex flex-col gap-2.5"
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null)
            }}
          >
            {form.map((f, i) => (
              <FieldCard
                key={`${gen}-${f.key}`}
                field={f}
                index={i}
                count={form.length}
                klass={settings.class}
                open={openKey === f.key}
                readOnly={!canEdit}
                onToggle={() => setOpenKey((k) => (k === f.key ? null : f.key))}
                onChange={(patch) => patchField(i, patch)}
                onRemove={() => {
                  setF(form.filter((_, j) => j !== i))
                  setOpenKey(null)
                }}
                onMove={(to) => move(i, to)}
                dropTarget={dragFrom != null && dragOver === i && dragFrom !== i && dragFrom !== i - 1}
                dragProps={
                  canEdit && openKey !== f.key
                    ? {
                        draggable: true,
                        onDragStart: (e) => {
                          setDragFrom(i)
                          e.dataTransfer.effectAllowed = "move"
                          e.dataTransfer.setData("text/plain", f.key)
                        },
                        onDragOver: (e) => {
                          if (dragFrom == null) return
                          e.preventDefault()
                          setDragOver(i)
                        },
                        onDrop: (e) => {
                          e.preventDefault()
                          if (dragFrom != null) move(dragFrom, dragFrom < i ? i - 1 : i)
                          setDragFrom(null)
                          setDragOver(null)
                        },
                        onDragEnd: () => {
                          setDragFrom(null)
                          setDragOver(null)
                        },
                      }
                    : {}
                }
              />
            ))}
            {dragFrom != null && (
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(form.length)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  move(dragFrom, form.length - 1)
                  setDragFrom(null)
                  setDragOver(null)
                }}
                className={cn(
                  "h-8 rounded-lg border border-dashed",
                  dragOver === form.length ? "border-st-blue bg-st-blue-bg" : "border-transparent",
                )}
                aria-hidden
              />
            )}
          </div>
          {canEdit && <AddFieldMenu onAdd={add} />}
          <p className="m-0 mt-1 text-[12.5px] text-muted-foreground">
            Publishing v{nextVersion} changes future tasks only. Past submissions keep the v{detail.current_version}{" "}
            form they were completed on.
          </p>
        </section>

        {/* Live preview */}
        <aside
          aria-label="Phone preview"
          className="border-t border-divider bg-sidebar p-4 lg:col-span-2 xl:col-span-1 xl:border-t-0 xl:border-l"
        >
          <div className="mb-3 text-[12.5px] font-medium text-ink2">Live preview · staff app</div>
          <div className="xl:sticky xl:top-16">
            <PhonePreview
              form={form}
              title={settings.name}
              meta={[property?.name ?? "The View", freqLabel, `Class ${settings.class}`].join(" · ")}
            />
          </div>
        </aside>
      </div>

      {publishing && (
        <PublishDialog
          version={nextVersion}
          live={detail.current_version}
          usedAt={detail.used_at}
          busy={publish.isPending}
          onClose={() => setPublishing(false)}
          onPublish={(note) => publish.mutate(note)}
        />
      )}
      <ActionDialog
        open={discarding}
        onOpenChange={setDiscarding}
        busy={discard.isPending}
        title={`Discard the v${nextVersion} draft?`}
        subtitle={settings.name}
        footer={
          <>
            <Button variant="outline" onClick={() => setDiscarding(false)}>
              Keep editing
            </Button>
            <Button
              variant="outline"
              className="border-st-red/50 text-st-red hover:bg-st-red-bg"
              disabled={discard.isPending}
              onClick={() => discard.mutate()}
            >
              {discard.isPending ? "Discarding…" : "Discard draft"}
            </Button>
          </>
        }
      >
        <p className="m-0">
          Every change since v{detail.current_version} is thrown away. Staff keep using v{detail.current_version}, so
          nothing changes for them.
        </p>
      </ActionDialog>
      {archiving && (
        <ArchiveDialog
          row={{ id: detail.id, name: settings.name, used_at: detail.used_at }}
          onClose={() => setArchiving(false)}
          onDone={() => void navigate({ to: "/settings/library" })}
        />
      )}
    </div>
  )
}

function PublishDialog({
  version,
  live,
  usedAt,
  busy,
  onClose,
  onPublish,
}: {
  version: number
  live: number
  usedAt: number
  busy: boolean
  onClose: () => void
  onPublish: (note: string) => void
}) {
  const [note, setNote] = React.useState("")
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={busy}
      title={`Publish v${version}?`}
      subtitle={usedAt ? `Used at ${plural(usedAt, "property", "properties")}` : "Not used at any property yet"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => onPublish(note.trim())}>
            {busy ? "Publishing…" : `Publish v${version}`}
          </Button>
        </>
      }
    >
      <p className="m-0">
        Future tasks that nobody has started use v{version}. Past submissions keep the v{live} form they were completed
        on.
      </p>
      <Labeled label="What changed (shown in the version history)" htmlFor="pub-note">
        <TextInput
          id="pub-note"
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Ask staff to phone the alarm company"
        />
      </Labeled>
    </ActionDialog>
  )
}

function VersionHistory({ versions, current }: { versions: Version[]; current: number }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <History aria-hidden />
          Version history
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-0">
        <div className="border-b border-divider px-3.5 py-2.5 text-[13px] font-semibold">Version history</div>
        <ol className="m-0 max-h-80 list-none overflow-y-auto p-0">
          {versions.map((v) => (
            <li key={v.version} className="flex gap-3 border-b border-divider px-3.5 py-2.5 last:border-0">
              <span className="mono-id w-7 shrink-0 pt-0.5 text-[12.5px] font-semibold">v{v.version}</span>
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="flex items-center gap-2">
                  {v.status === "draft" ? (
                    <Pill tone="amber">Draft</Pill>
                  ) : v.version === current ? (
                    <Pill tone="green">Live</Pill>
                  ) : (
                    <Pill tone="grey">Replaced</Pill>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {v.published_at ? fmtDate(v.published_at) : "Not published"}
                    {v.by ? ` · ${v.by}` : ""}
                  </span>
                </div>
                {v.note && <div className="mt-1 text-ink2">{v.note}</div>}
                <div className="mt-0.5 text-xs text-muted-foreground">{plural(v.tasks, "task")} on this version</div>
              </div>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  )
}

/* Applies-to rules (CMS-10): which properties get this check proposed when their register is set up. */
const JURISDICTIONS: { label: string; value: string[] }[] = [
  { label: "Scotland only", value: ["scotland"] },
  { label: "England only", value: ["england"] },
  { label: "Scotland + England", value: ["scotland", "england"] },
]
const REGIMES: { label: string; value: string }[] = [
  { label: "STL licence", value: "stl" },
  { label: "Class 7 hotel", value: "class7_hotel" },
]

function condLabel(c: Cond): string {
  if (c.feature) return humanise(c.feature)
  if (c.jurisdiction) return c.jurisdiction.map((j) => humanise(j)).join(" + ")
  if (c.licence_regime) return REGIMES.find((r) => r.value === c.licence_regime)?.label ?? humanise(c.licence_regime)
  return "Any property"
}

function AppliesTo({
  rule,
  features,
  disabled,
  onChange,
}: {
  rule: Rule | null
  features: string[]
  disabled: boolean
  onChange: (r: Rule | null) => void
}) {
  const [open, setOpen] = React.useState(false)
  const mode: "all" | "any" = rule?.any ? "any" : "all"
  const conds = rule?.[mode] ?? []
  const write = (next: Cond[], m = mode) => onChange(next.length ? ({ [m]: next } as Rule) : null)
  const used = new Set(conds.map((c) => c.feature).filter(Boolean))
  const pick = (c: Cond) => {
    write([...conds.filter((x) => !(c.jurisdiction && x.jurisdiction) && !(c.licence_regime && x.licence_regime)), c])
    setOpen(false)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-ink2">Applies to</span>
        {conds.length > 1 && !disabled && (
          <Segmented
            label="Match"
            size="sm"
            value={mode}
            onChange={(m) => write(conds, m)}
            options={[
              { value: "all", label: "All" },
              { value: "any", label: "Any" },
            ]}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {conds.length === 0 && <span className="text-[13px] text-muted-foreground">Every property</span>}
        {conds.map((c, i) => (
          <Pill key={i} tone="grey" className="pr-1">
            {condLabel(c)}
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove rule ${condLabel(c)}`}
                onClick={() => write(conds.filter((_, j) => j !== i))}
                className="rounded-full p-0.5 hover:bg-border"
              >
                <X className="size-3" />
              </button>
            )}
          </Pill>
        ))}
        {!disabled && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-6 px-2 text-xs">
                <Plus className="size-3" /> Rule
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1.5">
              <div className="px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">The property has</div>
              <div className="max-h-48 overflow-y-auto">
                {features
                  .filter((f) => !used.has(f))
                  .map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => pick({ feature: f })}
                      className="block w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-hover"
                    >
                      {humanise(f)}
                    </button>
                  ))}
              </div>
              <div className="mt-1 border-t border-divider px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                Where
              </div>
              {JURISDICTIONS.map((j) => (
                <button
                  key={j.label}
                  type="button"
                  onClick={() => pick({ jurisdiction: j.value })}
                  className="block w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-hover"
                >
                  {j.label}
                </button>
              ))}
              <div className="mt-1 border-t border-divider px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                Licence
              </div>
              {REGIMES.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => pick({ licence_regime: r.value })}
                  className="block w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-hover"
                >
                  {r.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  )
}
