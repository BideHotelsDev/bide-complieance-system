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
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts"
import { fmtTime, listWords, shortName } from "@/lib/format"
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
  if (f.key === "notes") return "a note on what's wrong"
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
  const initialValues = React.useCallback(() => {
    const v: Record<string, unknown> = {}
    for (const f of task.form) if (f.type === "location" && f.suggested) v[f.key] = f.suggested
    return v
  }, [task.form])
  const [values, setValues] = React.useState<Record<string, unknown>>(initialValues)
  const [signature, setSignature] = React.useState<string | null>(null)
  const { shots, add, remove, restore, ensureUploaded } = useShots({
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

  // Half-done work is kept on the phone as it changes and put back when the check is opened again.
  const [draftLoaded, setDraftLoaded] = React.useState(false)
  const [keptFrom, setKeptFrom] = React.useState<string | null>(null)
  const finished = React.useRef(false)
  React.useEffect(() => {
    let live = true
    void loadDraft(task.task_id).then((d) => {
      if (!live) return
      if (d && task.can_submit) {
        setValues({ ...initialValues(), ...d.values })
        setSignature(d.signature)
        restore(d.shots)
        setKeptFrom(d.saved_at)
      }
      setDraftLoaded(true)
    })
    return () => {
      live = false
    }
    // Once per check: the form is keyed by task id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const started =
    shots.length > 0 ||
    signature !== null ||
    Object.entries(values).some(([k, v]) => !isEmpty(v) && v !== initialValues()[k])
  // What to keep right now, or null for nothing (not started, already sent, or not loaded yet).
  const keep = React.useRef<(() => void) | null>(null)
  React.useEffect(() => {
    keep.current =
      !draftLoaded || !task.can_submit
        ? null
        : () => {
            if (finished.current) return
            if (!started) void clearDraft(task.task_id)
            else
              void saveDraft(task.task_id, {
                values,
                signature,
                shots: shots.map((x) => ({
                  key: x.key,
                  blob: x.blob,
                  captured_at: x.captured_at,
                  via: x.via,
                  evidence_id: x.evidence_id,
                })),
              })
          }
    const t = setTimeout(() => keep.current?.(), 400)
    return () => clearTimeout(t)
  }, [draftLoaded, started, values, signature, shots, task.task_id, task.can_submit])
  // Keep it at once when the app goes to the background (the phone may close it) or the check is left.
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
  const finish = async () => {
    finished.current = true
    await clearDraft(task.task_id)
  }
  const startAgain = () => {
    setValues(initialValues())
    setSignature(null)
    for (const x of shots) remove(x.id)
    setKeptFrom(null)
    void clearDraft(task.task_id)
  }

  const set = (key: string, v: unknown) => setValues((all) => ({ ...all, [key]: v }))
  const photoFields = form.filter((f) => f.type === "photo")
  const need = (f: FormField) => (f.required === false ? 0 : Math.max(1, f.min_photos ?? 1))
  const count = (key: string) => shots.filter((s) => s.key === key).length
  const photosNeeded = Math.max(
    1,
    photoFields.reduce((n, f) => n + need(f), 0),
  )
  const photosTaken = photoFields.reduce((n, f) => n + Math.min(count(f.key), need(f)), 0)

  const lifeSafety = task.class === "A"
  const problem = form.some((f) => failing(f, values[f.key]))
  // A life-safety problem goes to whoever fixes it straight away: it needs a word on what's wrong.
  const noteNeeded = (f: FormField) => lifeSafety && problem && f.key === "notes"
  const missing = form.filter((f) => {
    if (noteNeeded(f)) return isEmpty(values[f.key]) || String(values[f.key]).trim() === ""
    if (EVIDENCE.has(f.type)) return count(f.key) < need(f)
    if (f.type === "signature") return Boolean(f.required) && !signature
    if (f.type === "number" && !isEmpty(values[f.key]) && Number.isNaN(Number(values[f.key]))) return true
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
      await finish()
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
      await finish()
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

  // "3 of 5 done": every answer, photo or signature the check asks for.
  const counted = form.filter((f) => EVIDENCE.has(f.type) || noteNeeded(f) || Boolean(f.required))
  const doneCount = counted.filter((f) => !missing.includes(f)).length
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
          {task.can_submit && counted.length > 1 && (
            <div className="mb-2.5 flex items-center gap-3 text-[0.8125rem] text-muted-foreground">
              <div
                role="progressbar"
                aria-label="Answered"
                aria-valuemin={0}
                aria-valuemax={counted.length}
                aria-valuenow={doneCount}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-divider"
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
                    problem ? "bg-st-red" : "bg-st-green",
                  )}
                  style={{ width: `${(100 * doneCount) / counted.length}%` }}
                />
              </div>
              <span className="tabular shrink-0">
                {doneCount} of {counted.length} done
              </span>
            </div>
          )}
          <PrimaryButton disabled={missing.length > 0 || sending || !task.can_submit} onClick={() => void submit()}>
            {sending && <Spinner />}
            {sending ? "Sending" : problem ? "Send and report problem" : "Submit check"}
          </PrimaryButton>
          <p aria-live="polite" className="m-0 mt-2 line-clamp-2 text-center text-[0.875rem] text-muted-foreground">
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
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-[0.96875rem] font-semibold [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />
            How to do this check
          </summary>
          <p className="m-0 px-4 pb-4 text-[0.9375rem] leading-relaxed text-ink2">{task.guidance}</p>
        </details>
      )}
      {keptFrom && (
        <div role="status" className="flex items-center gap-3 rounded-xl bg-st-blue-bg px-4 py-3 text-[0.9375rem]">
          <span className="min-w-0 flex-1">What you'd done at {fmtTime(keptFrom)} was kept on this phone.</span>
          <button type="button" className="h-11 shrink-0 px-2 font-semibold text-link" onClick={startAgain}>
            Start again
          </button>
        </div>
      )}
      {(task.status_note || task.rejected || !task.can_submit || task.na_pending) && (
        <div className="-mt-1 flex flex-col gap-2">
          {task.status_note && (
            <Pill tone="red" className="h-auto self-start py-1 text-[0.84375rem]">
              {task.status_note}
            </Pill>
          )}
          {task.rejected && (
            <div role="note" className="rounded-xl border border-st-red/30 bg-st-red-bg px-4 py-3 text-[0.9375rem]">
              <div className="font-semibold text-st-red">Send again</div>
              <div>"{task.rejected.comment}"</div>
            </div>
          )}
          {task.na_pending && task.can_submit && (
            <div role="note" className="rounded-xl bg-st-grey-bg px-4 py-3 text-[0.9375rem] text-ink2">
              You've asked to mark this not applicable. Until a manager agrees, it stays on your list and you can still
              do it.
            </div>
          )}
          {!task.can_submit && (
            <div role="note" className="rounded-xl bg-st-grey-bg px-4 py-3 text-[0.9375rem] text-ink2">
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
            lifeSafety={lifeSafety}
            problem={problem}
          />
        ))}

      {photoFields.length > 0 && (
        <section aria-labelledby="photos-h">
          <h2 id="photos-h" className="m-0 mb-2 text-[1rem] font-semibold">
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
                    className="flex aspect-[4/3] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-subtle bg-surface px-2 text-center text-[0.90625rem] font-semibold"
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
            <ul className="m-0 mt-2 list-none p-0 text-[0.84375rem] text-muted-foreground">
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
          className="min-h-12 self-center text-[0.9375rem] font-medium text-link"
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
      ? { icon: <Check aria-hidden className="size-3.5" />, text: "Uploaded", cls: "bg-st-green text-on-status" }
      : shot.status === "uploading"
        ? { icon: <Spinner className="size-3" />, text: "Uploading", cls: "bg-st-blue text-on-status" }
        : shot.status === "local"
          ? {
              icon: <span className="size-2 rounded-full bg-white" />,
              text: "On this phone",
              cls: "bg-st-amber text-on-status",
            }
          : {
              icon: <CircleAlert aria-hidden className="size-3.5" />,
              text: "Didn't upload",
              cls: "bg-st-red text-on-status",
            }
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-hover">
      <img src={shot.url} alt={`${label}, taken`} className="size-full object-cover" />
      <span
        className={cn(
          "absolute top-2 left-2 inline-flex h-6 items-center gap-1 rounded-full px-2 text-[0.75rem] font-semibold",
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
        className="absolute right-1.5 bottom-1.5 flex h-10 items-center gap-1 rounded-full bg-black/60 px-3 text-[0.8125rem] font-semibold text-white"
      >
        <RotateCcw aria-hidden className="size-3.5" />
        Retake
      </button>
    </div>
  )
}

/* Does this answer fail the check? The server decides for real (services/checks.py); this only lets the form say so
   while the person is still answering. */
function failing(f: FormField, v: unknown): boolean {
  if (isEmpty(v)) return false
  switch (f.type) {
    case "yes_no":
      return Boolean(f.fail_on) && v === f.fail_on
    case "pass_fail":
      return v === "fail"
    case "pass_fail_items":
      return Object.values((v as Record<string, string>) ?? {}).includes("fail")
    case "select":
      return (f.fail_options ?? []).includes(v as string)
    case "number": {
      const n = Number(v)
      return !Number.isNaN(n) && ((f.min != null && n < f.min) || (f.max != null && n > f.max))
    }
    default:
      return false
  }
}

function FailNote({ lifeSafety }: { lifeSafety: boolean }) {
  return (
    <p role="status" className="m-0 mt-2 flex items-start gap-2 text-[0.875rem] text-st-red">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        This is reported as a problem when you send, and someone is asked to fix it.
        {lifeSafety ? " Say what's wrong in the note below." : " A note below helps whoever fixes it."}
      </span>
    </p>
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
  lifeSafety,
  problem,
}: {
  field: FormField
  value: unknown
  onChange: (v: unknown) => void
  signature: string | null
  onSignature: (v: string | null) => void
  files: Shot[]
  onFile: (f: File) => void
  onRemoveFile: (id: string) => void
  lifeSafety: boolean
  /** Some answer on the form fails the check: the notes box asks what's wrong. */
  problem: boolean
}) {
  const id = `f-${f.key}`
  const labelId = `${id}-label`
  switch (f.type) {
    case "yes_no":
    case "pass_fail": {
      const opts =
        f.type === "yes_no"
          ? [
              { value: "yes", label: "Yes", tone: f.fail_on ? (f.fail_on === "yes" ? "fail" : "pass") : undefined },
              { value: "no", label: "No", tone: f.fail_on ? (f.fail_on === "no" ? "fail" : "pass") : undefined },
            ]
          : [
              { value: "pass", label: "Pass", tone: "pass" as const },
              { value: "fail", label: "Fail", tone: "fail" as const },
            ]
      return (
        <div>
          <FieldLabel id={labelId} help={f.help}>
            {f.label}
          </FieldLabel>
          <Choice
            value={value as string | undefined}
            options={opts as { value: string; label: string; tone?: "pass" | "fail" }[]}
            onChange={onChange}
            labelledBy={labelId}
          />
          {failing(f, value) && <FailNote lifeSafety={lifeSafety} />}
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
                <div id={`${labelId}-${it}`} className="mb-1.5 text-[0.9375rem]">
                  {it}
                </div>
                <Choice
                  value={v[it]}
                  labelledBy={`${labelId}-${it}`}
                  options={[
                    { value: "pass", label: "Pass", tone: "pass" },
                    { value: "fail", label: "Fail", tone: "fail" },
                  ]}
                  onChange={(r) => onChange({ ...v, [it]: r })}
                />
              </div>
            ))}
          </div>
          {failing(f, value) && <FailNote lifeSafety={lifeSafety} />}
        </div>
      )
    }
    case "number": {
      const raw = (value as string | undefined) ?? ""
      const n = raw === "" ? null : Number(raw)
      const notNumber = n !== null && Number.isNaN(n) && raw !== "-"
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
            {/* iPhone's decimal keypad has no minus key, so freezer readings (-18) need this button. */}
            <button
              type="button"
              aria-label={raw.startsWith("-") ? "Make positive" : "Make negative"}
              aria-pressed={raw.startsWith("-")}
              onClick={() => onChange(raw.startsWith("-") ? raw.slice(1) : `-${raw}`)}
              className="absolute inset-y-0 left-0 flex w-12 items-center justify-center rounded-l-xl border-r border-border text-[1.125rem] font-semibold text-ink2"
            >
              ±
            </button>
            <TextInput
              id={id}
              inputMode="decimal"
              value={raw}
              onChange={(e) =>
                onChange(
                  e.target.value
                    .replace(/[^0-9.,-]/g, "")
                    .replace(",", ".")
                    .replace(/(?!^)-/g, ""),
                )
              }
              aria-invalid={notNumber || undefined}
              aria-describedby={notNumber || out ? `${id}-warn` : undefined}
              className={cn("tabular pr-14 pl-15", (out || notNumber) && "border-st-amber")}
            />
            {unit && (
              <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[1rem] text-muted-foreground">
                {unit}
              </span>
            )}
          </div>
          {notNumber && (
            <p id={`${id}-warn`} className="m-0 mt-1.5 text-[0.875rem] text-st-amber">
              That isn't a number. Type it like 3.5 or -18.
            </p>
          )}
          {out && (
            <p id={`${id}-warn`} className="m-0 mt-1.5 text-[0.875rem] text-st-amber">
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
        <label className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-[1rem]">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="size-6 shrink-0 accent-[var(--c-primary)]"
          />
          <span>
            {f.label}
            {f.help && <span className="block text-[0.875rem] text-muted-foreground">{f.help}</span>}
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
              className="mb-2 flex min-h-12 items-center gap-2 rounded-xl border border-divider bg-surface px-3.5 py-2 text-[0.9375rem]"
            >
              <span className="min-w-0 flex-1 truncate">{s.blob instanceof File ? s.blob.name : f.label}</span>
              <span className="text-[0.8125rem] text-muted-foreground">
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
                className="min-h-10 px-2 text-[0.875rem] font-semibold text-st-red"
                onClick={() => onRemoveFile(s.id)}
              >
                Remove
              </button>
            </div>
          ))}
          <label className="flex h-12 cursor-pointer items-center justify-center rounded-xl border border-dashed border-subtle bg-surface text-[0.96875rem] font-semibold">
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
      // Once an answer fails, the notes box asks what's wrong; on a life-safety check it must be filled in.
      const asks = f.key === "notes" && problem
      return (
        <div>
          <FieldLabel htmlFor={id} help={asks ? "What you saw, where, and anything you did about it." : f.help}>
            {asks ? "What's wrong?" : f.label}
            {!f.required && !(asks && lifeSafety) && (
              <span className="font-normal text-muted-foreground"> (optional)</span>
            )}
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
