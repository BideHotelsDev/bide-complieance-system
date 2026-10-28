/*
 * Do a check (design: AppTask, AppCamera, AppResult; EXE-02..06). Fields come from the template's form. Submit stays
 * disabled until everything required is done, and says what is left. With no signal the check is saved on the phone
 * (values, device time and the original photos) and sends by itself later.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useParams } from "@tanstack/react-router"
import { api, ApiError } from "@bide-comply/api-client"
import { Pill } from "@bide-comply/ui/components/status"
import { toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"
import { Camera as CameraIcon, Check, ChevronRight, CircleAlert, Plus, RotateCcw } from "lucide-react"
import * as React from "react"

import { Camera } from "@/components/Camera"
import {
  Choice,
  ErrorBox,
  FieldLabel,
  FlowScreen,
  Loading,
  PrimaryButton,
  SelectBox,
  Spinner,
  TextArea,
  TextInput,
} from "@/components/kit"
import { NaSheet } from "@/components/NaSheet"
import { FailedResult } from "@/components/Result"
import { SignaturePad } from "@/components/SignaturePad"
import { toastSaved, toastSent } from "@/components/sync"
import { cachedGet } from "@/lib/cache"
import { listWords, shortName } from "@/lib/format"
import { locateOnce } from "@/lib/geo"
import { enqueue } from "@/lib/queue"
import { useMe } from "@/lib/session"
import { useShots, type Shot } from "@/lib/shots"
import type { FormField, SubmitResult, TaskDetail } from "@/lib/types"

const EVIDENCE = new Set(["photo", "file"])

function isEmpty(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && v !== null && Object.keys(v).length === 0)
  )
}

/* "alarm company answer", "log book photo": short words for what is left. */
function leftWord(f: FormField): string {
  const l = f.label.replace(/\?$/, "").trim()
  const lower = l.charAt(0).toLowerCase() + l.slice(1)
  if (f.type === "photo") return /photo/i.test(l) ? lower : `${lower} photo`
  return lower
}

export function TaskPage() {
  const { taskId } = useParams({ from: "/authed/task/$taskId" })
  const detail = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => cachedGet<TaskDetail>(`/api/field/tasks/${taskId}`),
  })
  if (detail.isPending)
    return (
      <FlowScreen title="Loading" backLabel="Back to Today">
        <Loading label="Loading the check" />
      </FlowScreen>
    )
  if (detail.error)
    return (
      <FlowScreen title="Check" backLabel="Back to Today">
        <ErrorBox
          message={
            (detail.error as ApiError).status === 0
              ? "This check isn't saved on this phone. Open it again when you have signal."
              : detail.error.message
          }
          onRetry={() => void detail.refetch()}
        />
      </FlowScreen>
    )
  return <CheckForm key={detail.data.task_id} task={detail.data} />
}

function CheckForm({ task }: { task: TaskDetail }) {
  const me = useMe()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const form = React.useMemo<FormField[]>(() => {
    // Every check carries at least one photo (golden rule 1): add a slot if the form has none.
    if (task.form.some((f) => EVIDENCE.has(f.type))) return task.form
    return [...task.form, { key: "photo", type: "photo", label: "Photo", required: true, min_photos: 1 }]
  }, [task.form])
  const [values, setValues] = React.useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {}
    for (const f of task.form) if (f.type === "location" && f.suggested) v[f.key] = f.suggested
    return v
  })
  const [signature, setSignature] = React.useState<string | null>(null)
  const { shots, add, remove, ensureUploaded } = useShots({
    property_id: task.property_id,
    task_id: task.task_id,
    ref: task.ref,
  })
  const [camera, setCamera] = React.useState<FormField | null>(null)
  const [sending, setSending] = React.useState(false)
  const [result, setResult] = React.useState<SubmitResult | null>(null)
  const [na, setNa] = React.useState(false)
  const example = useQuery({
    queryKey: ["evidence", task.example_photo_id],
    queryFn: () => api.get<{ url: string }>(`/api/evidence/${task.example_photo_id}`),
    enabled: Boolean(task.example_photo_id),
    retry: false,
  })

  const set = (key: string, v: unknown) => setValues((all) => ({ ...all, [key]: v }))
  const photoFields = form.filter((f) => f.type === "photo")
  const need = (f: FormField) => (f.required === false ? 0 : Math.max(1, f.min_photos ?? 1))
  const count = (key: string) => shots.filter((s) => s.key === key).length
  const photosNeeded = Math.max(
    1,
    photoFields.reduce((n, f) => n + need(f), 0),
  )
  const photosTaken = photoFields.reduce((n, f) => n + Math.min(count(f.key), need(f)), 0)

  const missing = form.filter((f) => {
    if (EVIDENCE.has(f.type)) return count(f.key) < need(f)
    if (f.type === "signature") return Boolean(f.required) && !signature
    return Boolean(f.required) && isEmpty(values[f.key])
  })

  const submit = async () => {
    setSending(true)
    const deviceTime = new Date().toISOString()
    const fix = await locateOnce(4000)
    const vals: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(values)) if (!isEmpty(v)) vals[k] = v
    for (const f of form) if (f.type === "signature" && signature) vals[f.key] = "signed"
    const save = async (taken: Shot[]) => {
      await enqueue({
        task_id: task.task_id,
        ref: task.ref,
        title: task.title,
        property: task.property,
        property_id: task.property_id,
        values: vals,
        signature,
        photos: taken.map((s) => ({
          key: s.key,
          blob: s.blob,
          captured_at: s.captured_at,
          via: s.via,
          evidence_id: s.evidence_id,
        })),
        device_time: deviceTime,
        lat: fix?.lat ?? null,
        lng: fix?.lng ?? null,
        accuracy: fix?.accuracy ?? null,
      })
      toastSaved()
      void navigate({ to: "/" })
    }
    let taken: Shot[] = shots
    try {
      const up = await ensureUploaded()
      taken = up.shots
      if (up.status === "offline") return await save(taken)
      if (up.status === "error") {
        toastError("A photo didn't finish uploading. Take it again.")
        return
      }
      const photos: Record<string, string[]> = {}
      for (const s of taken) if (s.evidence_id) (photos[s.key] ??= []).push(s.evidence_id)
      const res = await api.post<SubmitResult>(`/api/field/tasks/${task.task_id}/submit`, {
        values: vals,
        signature,
        photos,
        device_time: deviceTime,
        captured_offline: false,
        lat: fix?.lat ?? null,
        lng: fix?.lng ?? null,
        accuracy: fix?.accuracy ?? null,
      })
      void qc.invalidateQueries({ queryKey: ["today"] })
      void qc.invalidateQueries({ queryKey: ["history"] })
      void qc.invalidateQueries({ queryKey: ["field-me"] })
      void qc.invalidateQueries({ queryKey: ["task", task.task_id] })
      if (res.result === "failed") {
        setResult(res)
        window.scrollTo(0, 0)
      } else {
        toastSent()
        void navigate({ to: "/" })
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) return await save(taken)
      toastError(e instanceof Error ? e.message : "Couldn't send. Try again.")
    } finally {
      setSending(false)
    }
  }

  if (result) return <FailedResult task={task} result={result} />

  const words = missing.map(leftWord)
  const left = words.length > 2 ? [...words.slice(0, 2), `${words.length - 2} more`] : words
  const cameraIndex = Math.min(photosTaken + 1, photosNeeded)

  return (
    <FlowScreen
      title={task.title}
      subtitle={`${task.property} · ${task.frequency}`}
      backLabel="Back to Today"
      right={task.class === "A" ? <Pill tone="red">Life safety</Pill> : undefined}
      footer={
        <>
          <PrimaryButton disabled={missing.length > 0 || sending || !task.can_submit} onClick={() => void submit()}>
            {sending && <Spinner />}
            {sending ? "Sending" : "Submit check"}
          </PrimaryButton>
          <p aria-live="polite" className="m-0 mt-2 line-clamp-2 text-center text-[14px] text-muted-foreground">
            {!task.can_submit
              ? "This check can't be sent now."
              : missing.length
                ? `${missing.length} thing${missing.length === 1 ? "" : "s"} left: ${listWords(left)}`
                : "Ready to send"}
          </p>
        </>
      }
    >
      {task.guidance && (
        <details className="group rounded-xl border border-divider bg-surface">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-[15.5px] font-semibold [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />
            How to do this check
          </summary>
          <p className="m-0 px-4 pb-4 text-[15px] leading-relaxed text-ink2">{task.guidance}</p>
        </details>
      )}
      {(task.status_note || task.rejected || !task.can_submit || task.na_pending) && (
        <div className="-mt-1 flex flex-col gap-2">
          {task.status_note && (
            <Pill tone="red" className="h-auto self-start py-1 text-[13.5px]">
              {task.status_note}
            </Pill>
          )}
          {task.rejected && (
            <div role="note" className="rounded-xl border border-st-red/30 bg-st-red-bg px-4 py-3 text-[15px]">
              <div className="font-semibold text-st-red">Send again</div>
              <div>"{task.rejected.comment}"</div>
            </div>
          )}
          {task.na_pending && task.can_submit && (
            <div role="note" className="rounded-xl bg-st-grey-bg px-4 py-3 text-[15px] text-ink2">
              You've asked to mark this not applicable. Until a manager agrees, it stays on your list and you can still
              do it.
            </div>
          )}
          {!task.can_submit && (
            <div role="note" className="rounded-xl bg-st-grey-bg px-4 py-3 text-[15px] text-ink2">
              {task.status === "scheduled"
                ? "This check isn't open yet."
                : "This check has already been sent in, or its window has closed."}
            </div>
          )}
        </div>
      )}

      {form
        .filter((f) => f.type !== "photo")
        .map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            value={values[f.key]}
            onChange={(v) => set(f.key, v)}
            signature={signature}
            onSignature={setSignature}
            files={shots.filter((s) => s.key === f.key)}
            onFile={(file) => add(f.key, file, new Date().toISOString(), "upload")}
            onRemoveFile={remove}
          />
        ))}

      {photoFields.length > 0 && (
        <section aria-labelledby="photos-h">
          <h2 id="photos-h" className="m-0 mb-2 text-[16px] font-semibold">
            Photos · {photosTaken} of {photosNeeded}
          </h2>
          <div className="grid grid-cols-2 gap-2.5">
            {photoFields.flatMap((f) => {
              const mine = shots.filter((s) => s.key === f.key)
              const slots = mine.map((s) => (
                <ShotTile key={s.id} shot={s} label={f.label} onRemove={() => remove(s.id)} />
              ))
              const room = mine.length < Math.max(need(f), f.max_photos ?? 1)
              if (room)
                slots.push(
                  <button
                    key={`${f.key}-add`}
                    type="button"
                    onClick={() => setCamera(f)}
                    className="flex aspect-[4/3] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-subtle bg-surface px-2 text-center text-[14.5px] font-semibold"
                  >
                    {mine.length ? (
                      <Plus aria-hidden className="size-5" />
                    ) : (
                      <CameraIcon aria-hidden className="size-5" />
                    )}
                    {mine.length ? "Another photo" : f.label}
                  </button>,
                )
              return slots
            })}
          </div>
          {photoFields.some((f) => f.help) && (
            <ul className="m-0 mt-2 list-none p-0 text-[13.5px] text-muted-foreground">
              {photoFields
                .filter((f) => f.help)
                .map((f) => (
                  <li key={f.key}>
                    {f.label}: {f.help}
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}

      {task.can_request_na && task.can_submit && (
        <button
          type="button"
          onClick={() => setNa(true)}
          className="min-h-12 self-center text-[15px] font-medium text-link"
        >
          This check doesn't apply? Mark as not applicable
        </button>
      )}

      {camera && (
        <Camera
          title={camera.label}
          hint={camera.help}
          index={cameraIndex}
          total={photosNeeded}
          stampPrefix={`${task.property} · ${task.ref} · ${shortName(me.data?.name ?? "")}`}
          exampleUrl={example.data?.url}
          site={task.geofence}
          onClose={() => setCamera(null)}
          onCapture={(blob, at) => {
            add(camera.key, blob, at)
            setCamera(null)
          }}
        />
      )}
      <NaSheet open={na} onClose={() => setNa(false)} task={task} />
    </FlowScreen>
  )
}

function ShotTile({ shot, label, onRemove }: { shot: Shot; label: string; onRemove: () => void }) {
  const status =
    shot.status === "done"
      ? { icon: <Check aria-hidden className="size-3.5" />, text: "Uploaded", cls: "bg-st-green text-white" }
      : shot.status === "uploading"
        ? { icon: <Spinner className="size-3" />, text: "Uploading", cls: "bg-st-blue text-white" }
        : shot.status === "local"
          ? {
              icon: <span className="size-2 rounded-full bg-white" />,
              text: "On this phone",
              cls: "bg-st-amber text-white",
            }
          : {
              icon: <CircleAlert aria-hidden className="size-3.5" />,
              text: "Didn't upload",
              cls: "bg-st-red text-white",
            }
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-hover">
      <img src={shot.url} alt={`${label}, taken`} className="size-full object-cover" />
      <span
        className={cn(
          "absolute top-2 left-2 inline-flex h-6 items-center gap-1 rounded-full px-2 text-[12px] font-semibold",
          status.cls,
        )}
      >
        {status.icon}
        {status.text}
      </span>
      <button
        type="button"
        aria-label={`Retake ${label}`}
        onClick={onRemove}
        className="absolute right-1.5 bottom-1.5 flex h-10 items-center gap-1 rounded-full bg-black/60 px-3 text-[13px] font-semibold text-white"
      >
        <RotateCcw aria-hidden className="size-3.5" />
        Retake
      </button>
    </div>
  )
}

function FieldInput({
  field: f,
  value,
  onChange,
  signature,
  onSignature,
  files,
  onFile,
  onRemoveFile,
}: {
  field: FormField
  value: unknown
  onChange: (v: unknown) => void
  signature: string | null
  onSignature: (v: string | null) => void
  files: Shot[]
  onFile: (f: File) => void
  onRemoveFile: (id: string) => void
}) {
  const id = `f-${f.key}`
  const labelId = `${id}-label`
  switch (f.type) {
    case "yes_no":
    case "pass_fail": {
      const opts =
        f.type === "yes_no"
          ? [
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ]
          : [
              { value: "pass", label: "Pass" },
              { value: "fail", label: "Fail" },
            ]
      return (
        <div>
          <FieldLabel id={labelId} help={f.help}>
            {f.label}
          </FieldLabel>
          <Choice value={value as string | undefined} options={opts} onChange={onChange} labelledBy={labelId} />
        </div>
      )
    }
    case "pass_fail_items": {
      const items = f.items ?? f.options ?? []
      const v = (value as Record<string, string> | undefined) ?? {}
      return (
        <div>
          <FieldLabel id={labelId} help={f.help}>
            {f.label}
          </FieldLabel>
          <div className="flex flex-col gap-3">
            {items.map((it) => (
              <div key={it}>
                <div id={`${labelId}-${it}`} className="mb-1.5 text-[15px]">
                  {it}
                </div>
                <Choice
                  value={v[it]}
                  labelledBy={`${labelId}-${it}`}
                  options={[
                    { value: "pass", label: "Pass" },
                    { value: "fail", label: "Fail" },
                  ]}
                  onChange={(r) => onChange({ ...v, [it]: r })}
                />
              </div>
            ))}
          </div>
        </div>
      )
    }
    case "number": {
      const n = value === undefined || value === "" ? null : Number(value)
      const out = n !== null && !Number.isNaN(n) && ((f.min != null && n < f.min) || (f.max != null && n > f.max))
      const unit = f.unit ?? ""
      const range =
        f.min != null && f.max != null
          ? `Between ${f.min} and ${f.max}${unit}`
          : f.min != null
            ? `At least ${f.min}${unit}`
            : f.max != null
              ? `No more than ${f.max}${unit}`
              : null
      return (
        <div>
          <FieldLabel htmlFor={id} help={f.help ?? range}>
            {f.label}
          </FieldLabel>
          <div className="relative">
            <TextInput
              id={id}
              inputMode="decimal"
              value={(value as string | undefined) ?? ""}
              onChange={(e) => onChange(e.target.value.replace(/[^0-9.,-]/g, "").replace(",", "."))}
              aria-describedby={out ? `${id}-warn` : undefined}
              className={cn("tabular pr-14", out && "border-st-amber")}
            />
            {unit && (
              <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[16px] text-muted-foreground">
                {unit}
              </span>
            )}
          </div>
          {out && (
            <p id={`${id}-warn`} className="m-0 mt-1.5 text-[14px] text-st-amber">
              Outside the safe range. You can still send it; it will be logged as Failed so it gets fixed.
            </p>
          )}
        </div>
      )
    }
    case "location":
    case "select": {
      const opts = (f.options ?? []).map((o) => ({ value: o, label: o }))
      return (
        <div>
          <FieldLabel htmlFor={id} help={f.type === "location" ? undefined : f.help}>
            {f.label}
          </FieldLabel>
          <SelectBox
            id={id}
            value={(value as string | undefined) ?? ""}
            onChange={onChange}
            options={opts}
            hint={f.suggested && value === f.suggested ? "Next in rotation" : undefined}
          />
        </div>
      )
    }
    case "checkbox":
      return (
        <label className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-[16px]">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="size-6 shrink-0 accent-[var(--c-primary)]"
          />
          <span>
            {f.label}
            {f.help && <span className="block text-[14px] text-muted-foreground">{f.help}</span>}
          </span>
        </label>
      )
    case "date":
      return (
        <div>
          <FieldLabel htmlFor={id} help={f.help}>
            {f.label}
          </FieldLabel>
          <TextInput
            id={id}
            type="date"
            value={(value as string | undefined) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )
    case "signature":
      return (
        <div>
          <FieldLabel id={labelId} help={f.help}>
            {f.label}
          </FieldLabel>
          <SignaturePad value={signature} onChange={onSignature} labelledBy={labelId} />
        </div>
      )
    case "file":
      return (
        <div>
          <FieldLabel htmlFor={id} help={f.help}>
            {f.label}
          </FieldLabel>
          {files.map((s) => (
            <div
              key={s.id}
              className="mb-2 flex min-h-12 items-center gap-2 rounded-xl border border-divider bg-surface px-3.5 py-2 text-[15px]"
            >
              <span className="min-w-0 flex-1 truncate">{s.blob instanceof File ? s.blob.name : f.label}</span>
              <span className="text-[13px] text-muted-foreground">
                {s.status === "done"
                  ? "Uploaded"
                  : s.status === "uploading"
                    ? "Uploading"
                    : s.status === "local"
                      ? "On this phone"
                      : "Didn't upload"}
              </span>
              <button
                type="button"
                className="min-h-10 px-2 text-[14px] font-semibold text-st-red"
                onClick={() => onRemoveFile(s.id)}
              >
                Remove
              </button>
            </div>
          ))}
          <label className="flex h-12 cursor-pointer items-center justify-center rounded-xl border border-dashed border-subtle bg-surface text-[15.5px] font-semibold">
            Choose a file
            <input
              id={id}
              type="file"
              accept="application/pdf,image/*"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ""
                if (file) onFile(file)
              }}
            />
          </label>
        </div>
      )
    case "text":
    default: {
      const long = /note|describe|detail|comment|what/i.test(f.key + f.label)
      return (
        <div>
          <FieldLabel htmlFor={id} help={f.help}>
            {f.label}
            {!f.required && <span className="font-normal text-muted-foreground"> (optional)</span>}
          </FieldLabel>
          {long ? (
            <TextArea id={id} value={(value as string | undefined) ?? ""} onChange={(e) => onChange(e.target.value)} />
          ) : (
            <TextInput id={id} value={(value as string | undefined) ?? ""} onChange={(e) => onChange(e.target.value)} />
          )}
        </div>
      )
    }
  }
}
