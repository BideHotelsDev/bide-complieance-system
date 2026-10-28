/*
 * The check form builder (design: TemplateEditor, CMS-02): ordered fields that staff answer, each expandable to edit,
 * reorderable by drag, keyboard or the move buttons, and a live phone preview that renders the form like the staff app.
 */
import * as React from "react"
import {
  Calendar,
  Camera,
  ChevronDown,
  ChevronUp,
  FileUp,
  GripVertical,
  ListChecks,
  MapPin,
  PenLine,
  Plus,
  SquareCheck,
} from "lucide-react"
import { Button } from "@bide-comply/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bide-comply/ui/components/dropdown-menu"
import { Pill } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import { Labeled, NativeSelect, TextArea, TextInput } from "./ui"

export type FieldType =
  | "checkbox"
  | "yes_no"
  | "pass_fail"
  | "pass_fail_items"
  | "number"
  | "text"
  | "select"
  | "location"
  | "photo"
  | "signature"
  | "file"
  | "date"

export type FormField = {
  key: string
  type: FieldType
  label: string
  help?: string
  required?: boolean
  fail_on?: "yes" | "no" | "unchecked"
  fail_text?: string
  unit?: string
  min?: number
  max?: number
  options?: string[]
  fail_options?: string[]
  items?: string[]
  min_photos?: number
  max_photos?: number
  source?: string
  example?: string
}

export const FIELD_TYPES: { type: FieldType; label: string; hint: string }[] = [
  { type: "yes_no", label: "Yes / No", hint: "A question; one answer can fail the check" },
  { type: "pass_fail", label: "Pass / Fail", hint: "Fail fails the check" },
  { type: "pass_fail_items", label: "Pass / Fail per item", hint: "A list of things, each passed or failed" },
  { type: "checkbox", label: "Tick box", hint: "Confirm something was done" },
  { type: "number", label: "Number with range", hint: "A reading outside the range fails the check" },
  { type: "select", label: "Select", hint: "Pick one answer from a list" },
  { type: "text", label: "Text", hint: "Notes or a short answer" },
  { type: "location", label: "Location", hint: "A room, call point or area at the property" },
  { type: "photo", label: "Photo", hint: "Taken with the in-app camera" },
  { type: "signature", label: "Signature", hint: "Signed on the phone" },
  { type: "file", label: "File", hint: "A certificate, report or job sheet" },
  { type: "date", label: "Date", hint: "For example an expiry date" },
]

export function TypeIcon({ type, className }: { type: FieldType; className?: string }) {
  const box = cn(
    "inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-hover text-[11.5px] font-semibold text-ink2 [&_svg]:size-3.5",
    className,
  )
  const text: Partial<Record<FieldType, string>> = { yes_no: "Y/N", pass_fail: "P/F", text: "Aa", number: "#" }
  const icon: Partial<Record<FieldType, React.ReactNode>> = {
    location: <MapPin />,
    photo: <Camera />,
    signature: <PenLine />,
    file: <FileUp />,
    date: <Calendar />,
    checkbox: <SquareCheck />,
    select: <ChevronDown />,
    pass_fail_items: <ListChecks />,
  }
  return (
    <span aria-hidden className={box}>
      {text[type] ?? icon[type]}
    </span>
  )
}

export function describe(f: FormField): string {
  const opt = f.required === false ? " · optional" : ""
  switch (f.type) {
    case "location":
      return f.source === "call_point"
        ? "Location · from the property's call points · suggests the next in rotation"
        : "Location · from the property's rooms and areas"
    case "yes_no":
      return f.fail_on === "no" || f.fail_on === "yes"
        ? `Yes / No · "${f.fail_on === "no" ? "No" : "Yes"}" fails the check`
        : `Yes / No · for the record${opt}`
    case "pass_fail":
      return `Pass / Fail · "Fail" fails the check`
    case "pass_fail_items":
      return `Pass / Fail per item · ${(f.items ?? []).length} items · any "Fail" fails the check`
    case "checkbox":
      return f.fail_on === "unchecked" ? "Tick box · not ticked fails the check" : `Tick box${opt}`
    case "number": {
      const range =
        f.min != null && f.max != null
          ? ` · ${f.min}–${f.max}${f.unit ?? ""}`
          : f.min != null
            ? ` · at least ${f.min}${f.unit ?? ""}`
            : f.max != null
              ? ` · at most ${f.max}${f.unit ?? ""}`
              : ""
      return `Number${f.unit ? ` in ${f.unit}` : ""}${range}${range ? " · outside fails the check" : ""}${opt}`
    }
    case "select":
      return `Select · ${(f.options ?? []).length} options${(f.fail_options ?? []).length ? ` · ${f.fail_options!.length} fail the check` : ""}${opt}`
    case "text":
      return `Text${opt}`
    case "photo":
      return `In-app camera · min ${f.min_photos ?? 1}${f.max_photos ? ` · max ${f.max_photos}` : ""}${f.example ? " · example photo attached" : ""}`
    case "signature":
      return `Signature${opt}`
    case "file":
      return `File · PDF or photo${opt}`
    case "date":
      return `Date${opt}`
  }
}

function fails(f: FormField): boolean {
  return (
    ((f.type === "yes_no" || f.type === "checkbox") && !!f.fail_on) ||
    f.type === "pass_fail" ||
    f.type === "pass_fail_items" ||
    (f.type === "number" && (f.min != null || f.max != null)) ||
    (f.type === "select" && (f.fail_options ?? []).length > 0)
  )
}

const CONSEQUENCE: Record<string, React.ReactNode> = {
  A: (
    <>
      Task is saved as <strong>Failed</strong> · an urgent action is raised, due the same day · Class A alert: the Super
      Admin, the system owner and the assessor (§7)
    </>
  ),
  B: (
    <>
      Task is saved as <strong>Failed</strong> · an action is raised (Soon, due in 30 days) and the accountable person
      is told
    </>
  ),
  C: (
    <>
      Task is saved as <strong>Failed</strong> · an action is raised (Later, due in 90 days)
    </>
  ),
}

export function newField(type: FieldType, existing: FormField[]): FormField {
  const base = type === "pass_fail_items" ? "items" : type
  let n = 1
  while (existing.some((f) => f.key === `${base}_${n}`)) n++
  const key = `${base}_${n}`
  const labels: Record<FieldType, string> = {
    yes_no: "New yes / no question",
    pass_fail: "New pass / fail check",
    pass_fail_items: "Items checked",
    checkbox: "Confirm this was done",
    number: "Reading",
    select: "Choose one",
    text: "Notes",
    location: "Location",
    photo: "Photo",
    signature: "Signature",
    file: "File",
    date: "Date",
  }
  const f: FormField = { key, type, label: labels[type], required: type !== "text" }
  if (type === "yes_no") f.fail_on = "no"
  if (type === "select") f.options = ["Option 1", "Option 2"]
  if (type === "pass_fail_items") f.items = ["First item", "Second item"]
  if (type === "photo") f.min_photos = 1
  return f
}

export function AddFieldMenu({ onAdd, disabled }: { onAdd: (t: FieldType) => void; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="flex h-10 w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-border bg-surface text-[13px] font-medium text-ink2 hover:bg-hover disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden />
          Add field · checkbox, yes/no, pass/fail, number with range, select, photo, signature, file, date
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-80">
        {FIELD_TYPES.map((t) => (
          <DropdownMenuItem key={t.type} onSelect={() => onAdd(t.type)} className="items-start gap-2.5 py-2">
            <TypeIcon type={t.type} className="size-6" />
            <span className="flex flex-col">
              <span className="text-[13px] font-medium text-foreground">{t.label}</span>
              <span className="text-xs text-muted-foreground">{t.hint}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const lines = (v: string) =>
  v
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)

/* A list typed one per line keeps its raw text while editing, so blank lines and spaces don't jump around. */
function LinesInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string
  value: string[]
  onChange: (v: string[]) => void
  disabled?: boolean
}) {
  const [raw, setRaw] = React.useState(value.join("\n"))
  React.useEffect(() => {
    if (lines(raw).join("\n") !== value.join("\n")) setRaw(value.join("\n"))
    // Only resync when the value changes from outside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <TextArea
      id={id}
      rows={Math.max(3, value.length + 1)}
      value={raw}
      disabled={disabled}
      onChange={(e) => {
        setRaw(e.target.value)
        onChange(lines(e.target.value))
      }}
    />
  )
}

function num(v: string): number | undefined {
  if (v.trim() === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function FieldCard({
  field: f,
  index,
  count,
  klass,
  open,
  readOnly,
  onToggle,
  onChange,
  onRemove,
  onMove,
  dragProps,
  dropTarget,
}: {
  field: FormField
  index: number
  count: number
  klass: string
  open: boolean
  readOnly: boolean
  onToggle: () => void
  onChange: (patch: Partial<FormField>) => void
  onRemove: () => void
  onMove: (to: number) => void
  dragProps: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean }
  dropTarget: boolean
}) {
  const id = `f-${f.key}`
  const requiredPill = (
    <Pill tone={f.required === false ? "outline" : "grey"} className="shrink-0">
      {f.required === false ? "Optional" : "Required"}
    </Pill>
  )
  return (
    <div
      {...dragProps}
      className={cn(
        "relative flex gap-2.5 rounded-[10px] border bg-surface px-3 py-3 transition-shadow",
        open ? "border-st-blue shadow-[0_0_0_1px_var(--c-blue)]" : "border-divider",
        dropTarget && "shadow-[0_-3px_0_0_var(--c-blue)]",
      )}
    >
      <button
        type="button"
        aria-label={`Move “${f.label}”, field ${index + 1} of ${count}. Drag, or use the arrow keys.`}
        disabled={readOnly}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" && index > 0) {
            e.preventDefault()
            onMove(index - 1)
          } else if (e.key === "ArrowDown" && index < count - 1) {
            e.preventDefault()
            onMove(index + 1)
          }
        }}
        className={cn(
          "mt-1 flex h-7 w-4 shrink-0 items-center justify-center rounded text-subtle",
          !readOnly && "cursor-grab hover:text-ink2 active:cursor-grabbing",
        )}
      >
        <GripVertical className="size-4" aria-hidden />
      </button>
      <TypeIcon type={f.type} className="mt-0.5" />
      {!open ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-foreground">{f.label || "Untitled field"}</span>
            <span className="block text-[12.5px] text-muted-foreground">{describe(f)}</span>
          </span>
          {requiredPill}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-start gap-3">
            <Labeled label="Label" htmlFor={`${id}-label`} className="flex-1">
              <TextInput
                id={`${id}-label`}
                autoFocus
                value={f.label}
                disabled={readOnly}
                aria-invalid={!f.label.trim() || undefined}
                onChange={(e) => onChange({ label: e.target.value })}
              />
            </Labeled>
            <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
              <label className="flex items-center gap-1.5 text-[12.5px] text-ink2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--c-primary)]"
                  checked={f.required !== false}
                  disabled={readOnly}
                  onChange={(e) => onChange({ required: e.target.checked })}
                />
                Required
              </label>
              {!readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-st-red/40 text-st-red hover:bg-st-red-bg"
                  onClick={onRemove}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
          <Labeled label="Help text for staff" htmlFor={`${id}-help`}>
            <TextInput
              id={`${id}-help`}
              value={f.help ?? ""}
              disabled={readOnly}
              placeholder="What to do, in plain words"
              onChange={(e) => onChange({ help: e.target.value || undefined })}
            />
          </Labeled>
          <TypeSettings f={f} id={id} readOnly={readOnly} onChange={onChange} />
          {fails(f) && (
            <>
              {f.type === "yes_no" && (f.fail_on === "no" || f.fail_on === "yes") && (
                <div className="rounded-lg bg-st-red-bg px-3 py-2.5 text-[13.5px] text-st-red">
                  <div className="font-semibold">If the answer is {f.fail_on === "no" ? "No" : "Yes"}</div>
                  <div className="mt-1">{CONSEQUENCE[klass] ?? CONSEQUENCE.B}</div>
                </div>
              )}
              <Labeled
                label="What the action says if this fails"
                htmlFor={`${id}-fail`}
                hint="Plain words for the action and the alert, e.g. “Alarm company did not get the weekly test signal”."
              >
                <TextInput
                  id={`${id}-fail`}
                  value={f.fail_text ?? ""}
                  disabled={readOnly}
                  onChange={(e) => onChange({ fail_text: e.target.value || undefined })}
                />
              </Labeled>
            </>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-2.5">
            {!readOnly && (
              <>
                <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => onMove(index - 1)}>
                  <ChevronUp /> Move up
                </Button>
                <Button variant="ghost" size="sm" disabled={index === count - 1} onClick={() => onMove(index + 1)}>
                  <ChevronDown /> Move down
                </Button>
              </>
            )}
            <span className="mono-id ml-auto text-xs text-subtle" title="Stored with every answer; fixed once created">
              {f.key}
            </span>
            <Button variant="outline" size="sm" onClick={onToggle}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function TypeSettings({
  f,
  id,
  readOnly,
  onChange,
}: {
  f: FormField
  id: string
  readOnly: boolean
  onChange: (patch: Partial<FormField>) => void
}) {
  switch (f.type) {
    case "yes_no":
      return (
        <Labeled label="Fails the check when the answer is" htmlFor={`${id}-failon`}>
          <NativeSelect
            id={`${id}-failon`}
            value={f.fail_on ?? ""}
            disabled={readOnly}
            onChange={(e) => onChange({ fail_on: (e.target.value || undefined) as FormField["fail_on"] })}
            options={[
              { value: "no", label: "No" },
              { value: "yes", label: "Yes" },
              { value: "", label: "Never (for the record only)" },
            ]}
          />
        </Labeled>
      )
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="size-4 accent-[var(--c-primary)]"
            checked={f.fail_on === "unchecked"}
            disabled={readOnly}
            onChange={(e) => onChange({ fail_on: e.target.checked ? "unchecked" : undefined })}
          />
          Not ticked fails the check
        </label>
      )
    case "number":
      return (
        <div className="grid grid-cols-3 gap-3">
          <Labeled label="Unit" htmlFor={`${id}-unit`}>
            <TextInput
              id={`${id}-unit`}
              value={f.unit ?? ""}
              placeholder="°C, ppm, mg/l"
              disabled={readOnly}
              onChange={(e) => onChange({ unit: e.target.value || undefined })}
            />
          </Labeled>
          <Labeled label="Lowest that passes" htmlFor={`${id}-min`}>
            <TextInput
              id={`${id}-min`}
              inputMode="decimal"
              defaultValue={f.min ?? ""}
              disabled={readOnly}
              onChange={(e) => onChange({ min: num(e.target.value) })}
            />
          </Labeled>
          <Labeled label="Highest that passes" htmlFor={`${id}-max`}>
            <TextInput
              id={`${id}-max`}
              inputMode="decimal"
              defaultValue={f.max ?? ""}
              disabled={readOnly}
              aria-invalid={(f.min != null && f.max != null && f.min > f.max) || undefined}
              onChange={(e) => onChange({ max: num(e.target.value) })}
            />
          </Labeled>
          <p className="col-span-3 m-0 text-xs text-muted-foreground">
            A reading outside the range fails the check but never stops staff submitting it.
          </p>
        </div>
      )
    case "select":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Options, one per line" htmlFor={`${id}-opts`}>
            <LinesInput
              id={`${id}-opts`}
              value={f.options ?? []}
              disabled={readOnly}
              onChange={(v) =>
                onChange({ options: v, fail_options: (f.fail_options ?? []).filter((x) => v.includes(x)) })
              }
            />
          </Labeled>
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 text-[12.5px] font-medium text-ink2">Answers that fail the check</legend>
            {(f.options ?? []).map((o) => (
              <label key={o} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--c-primary)]"
                  disabled={readOnly}
                  checked={(f.fail_options ?? []).includes(o)}
                  onChange={(e) =>
                    onChange({
                      fail_options: e.target.checked
                        ? [...(f.fail_options ?? []), o]
                        : (f.fail_options ?? []).filter((x) => x !== o),
                    })
                  }
                />
                {o}
              </label>
            ))}
          </fieldset>
        </div>
      )
    case "pass_fail_items":
      return (
        <Labeled label="Items, one per line" htmlFor={`${id}-items`} hint="Staff pass or fail each one.">
          <LinesInput
            id={`${id}-items`}
            value={f.items ?? []}
            disabled={readOnly}
            onChange={(v) => onChange({ items: v })}
          />
        </Labeled>
      )
    case "photo":
      return (
        <div className="grid grid-cols-2 gap-3">
          <Labeled label="Minimum photos" htmlFor={`${id}-minp`}>
            <NativeSelect
              id={`${id}-minp`}
              value={String(f.min_photos ?? 1)}
              disabled={readOnly}
              onChange={(e) => onChange({ min_photos: Number(e.target.value) })}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))}
            />
          </Labeled>
          <Labeled label="Maximum photos" htmlFor={`${id}-maxp`}>
            <NativeSelect
              id={`${id}-maxp`}
              value={f.max_photos ? String(f.max_photos) : ""}
              disabled={readOnly}
              onChange={(e) => onChange({ max_photos: e.target.value ? Number(e.target.value) : undefined })}
              options={[
                { value: "", label: "No limit" },
                ...[1, 2, 3, 4, 5, 10].map((n) => ({
                  value: String(n),
                  label: String(n),
                  disabled: n < (f.min_photos ?? 1),
                })),
              ]}
            />
          </Labeled>
        </div>
      )
    case "location":
      return (
        <Labeled label="Staff choose from" htmlFor={`${id}-src`}>
          <NativeSelect
            id={`${id}-src`}
            value={f.source ?? ""}
            disabled={readOnly}
            onChange={(e) => onChange({ source: e.target.value || undefined })}
            options={[
              { value: "", label: "The property's rooms and areas" },
              { value: "call_point", label: "The property's call points (suggests the next in rotation)" },
            ]}
          />
        </Labeled>
      )
    default:
      return null
  }
}

/* ---------------------------------------------------------------------------------------------------------------- */

export function PhonePreview({ form, title, meta }: { form: FormField[]; title: string; meta: string }) {
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const photos = form.filter((f) => f.type === "photo")
  const need = photos.reduce((n, f) => n + (f.min_photos ?? 1), 0)
  const firstPhoto = form.findIndex((f) => f.type === "photo")
  const set = (k: string, v: string) => setAnswers((a) => ({ ...a, [k]: a[k] === v ? "" : v }))
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-[34px] border-[7px] border-foreground bg-foreground shadow-sm">
      <div className="flex max-h-[640px] flex-col gap-3 overflow-y-auto rounded-[27px] bg-surface px-4 pt-5 pb-4">
        <div>
          <div className="text-xs text-muted-foreground">{meta}</div>
          <div className="text-[17px] leading-tight font-semibold">{title || "Untitled check"}</div>
        </div>
        {form.map((f, i) => {
          if (f.type === "photo") {
            if (i !== firstPhoto) return null
            return (
              <div key="photos" className="flex flex-col gap-1.5">
                <div className="text-[12.5px] font-medium">Photos · 0 of {need}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {photos.map((p) => (
                    <div
                      key={p.key}
                      className="flex h-16 items-center justify-center rounded-lg border border-dashed border-border px-1 text-center text-xs text-muted-foreground"
                    >
                      {p.label.replace(/^photo:\s*/i, "")}
                    </div>
                  ))}
                </div>
              </div>
            )
          }
          return (
            <div key={f.key} className="flex flex-col gap-1.5">
              {f.type !== "checkbox" && (
                <div className="text-[12.5px] font-medium">
                  {f.label}
                  {f.required === false && <span className="font-normal text-muted-foreground"> (optional)</span>}
                </div>
              )}
              {f.help && f.type !== "checkbox" && (
                <div className="line-clamp-1 text-xs text-muted-foreground">{f.help}</div>
              )}
              <PreviewInput f={f} value={answers[f.key] ?? ""} onPick={(v) => set(f.key, v)} />
            </div>
          )
        })}
        {form.length === 0 && (
          <div className="py-6 text-center text-xs text-muted-foreground">Add a field to see it here.</div>
        )}
        <div className="mt-1 flex h-11 items-center justify-center rounded-lg bg-subtle/60 text-[13.5px] font-medium text-white">
          Submit check
        </div>
      </div>
    </div>
  )
}

function Choice({ options, value, onPick }: { options: string[]; value: string; onPick: (v: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onPick(o)}
          className={cn(
            "h-10 rounded-lg border text-[13.5px]",
            value === o ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

function PreviewInput({ f, value, onPick }: { f: FormField; value: string; onPick: (v: string) => void }) {
  const box = "flex h-10 items-center justify-between rounded-lg border border-border px-2.5 text-[13px]"
  switch (f.type) {
    case "yes_no":
      return <Choice options={["Yes", "No"]} value={value} onPick={onPick} />
    case "pass_fail":
      return <Choice options={["Pass", "Fail"]} value={value} onPick={onPick} />
    case "pass_fail_items":
      return (
        <div className="flex flex-col divide-y divide-divider rounded-lg border border-border">
          {(f.items ?? []).map((it) => (
            <div key={it} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
              <span className="min-w-0 truncate">{it}</span>
              <span className="flex shrink-0 gap-1 text-[11px]">
                <span className="rounded border border-border px-1.5 py-0.5">Pass</span>
                <span className="rounded border border-border px-1.5 py-0.5">Fail</span>
              </span>
            </div>
          ))}
        </div>
      )
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-5 accent-[var(--c-primary)]" />
          {f.label}
        </label>
      )
    case "number":
      return (
        <div className={box}>
          <span className="text-muted-foreground">{f.min != null && f.max != null ? `${f.min}–${f.max}` : "0"}</span>
          <span className="text-muted-foreground">{f.unit}</span>
        </div>
      )
    case "select":
      return (
        <div className={box}>
          <span className="text-muted-foreground">Choose…</span>
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        </div>
      )
    case "location":
      return (
        <div className={box}>
          <span>{f.source === "call_point" ? "Next call point in rotation" : "Choose a room or area"}</span>
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        </div>
      )
    case "text":
      return <div className="h-14 rounded-lg border border-border" />
    case "signature":
      return (
        <div className="flex h-16 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
          Sign here
        </div>
      )
    case "file":
      return (
        <div className="flex h-11 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
          Attach a file
        </div>
      )
    case "date":
      return (
        <div className={box}>
          <span className="text-muted-foreground">dd/mm/yyyy</span>
          <Calendar className="size-4 text-muted-foreground" aria-hidden />
        </div>
      )
    default:
      return null
  }
}
