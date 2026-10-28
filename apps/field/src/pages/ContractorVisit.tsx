/*
 * Contractor visit (design: AppContractor, DOC-05/07). Staff log the visit on the contractor's behalf: who came, what
 * for (linked to the register item so it counts as done), the report or certificate, and anything they found wrong.
 * Each fix becomes an Action (Urgent: 7 days, Soon: 30 days).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { api, ApiError, upload, type Uploaded } from "@bide-comply/api-client"
import { toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"
import { Check, FileText, X } from "lucide-react"
import * as React from "react"

import { Choice, ErrorBox, FieldLabel, FlowScreen, Loading, PrimaryButton, SelectBox, Spinner, TextInput } from "@/components/kit"
import { toastCouldntSave, toastSent } from "@/components/sync"
import { fmtSize } from "@/lib/format"
import { useMe, useProperty } from "@/lib/session"
import type { VisitForm } from "@/lib/types"

type Fix = { text: string; priority: "high" | "med" }

export function ContractorVisitPage() {
  const me = useMe()
  const { propertyId } = useProperty()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const form = useQuery({
    queryKey: ["visit-form", propertyId],
    queryFn: () => api.get<VisitForm>("/api/field/contractor-visit", { property: propertyId }),
    enabled: Boolean(propertyId),
  })
  const [who, setWho] = React.useState("")
  const [adding, setAdding] = React.useState(false)
  const [newName, setNewName] = React.useState("")
  const [purpose, setPurpose] = React.useState<string | null>(null)
  const [file, setFile] = React.useState<File | null>(null)
  const [uploaded, setUploaded] = React.useState<Uploaded | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const [anyWrong, setAnyWrong] = React.useState<"no" | "yes" | null>(null)
  const [fixes, setFixes] = React.useState<Fix[]>([{ text: "", priority: "high" }])
  const [saving, setSaving] = React.useState(false)
  const propName = me.data?.properties.find((p) => p.id === propertyId)?.name

  const chosen = form.data?.purposes.find((p) => p.label === purpose)
  const realFixes = fixes.filter((f) => f.text.trim())
  const ready =
    (adding ? Boolean(newName.trim()) : Boolean(who)) &&
    Boolean(purpose) &&
    !uploading &&
    anyWrong !== null &&
    (anyWrong === "no" || realFixes.length > 0)

  const pick = async (f: File) => {
    setFile(f)
    setUploaded(null)
    setUploading(true)
    try {
      setUploaded(await upload(f, { captured_with: "upload", property_id: propertyId }))
    } catch (e) {
      setFile(null)
      if (e instanceof ApiError && e.status === 0) toastCouldntSave()
      else toastError(e instanceof Error ? e.message : "The upload didn't finish. Try again.")
    } finally {
      setUploading(false)
    }
  }

  const save = async () => {
    if (!propertyId || !purpose) return
    setSaving(true)
    try {
      const res = await api.post<{ id: string; actions: string[] }>("/api/field/contractor-visits", {
        contractor_id: adding ? null : who,
        new_contractor: adding ? newName.trim() : null,
        property_id: propertyId,
        purpose,
        register_item_id: chosen?.register_item_id ?? null,
        evidence_id: uploaded?.id ?? null,
        fails: anyWrong === "yes" ? realFixes.map((f) => ({ text: f.text.trim(), priority: f.priority })) : [],
      })
      toastSent(
        res.actions.length
          ? `Visit saved. ${res.actions.length} Action${res.actions.length === 1 ? "" : "s"} raised.`
          : "Visit saved. Thank you.",
      )
      void qc.invalidateQueries()
      void navigate({ to: "/" })
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) toastCouldntSave(() => void save())
      else toastError(e instanceof Error ? e.message : "Couldn't save. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <FlowScreen
      title="Contractor visit"
      right={propName && <span className="pr-1 text-[14px] text-muted-foreground">{propName}</span>}
      footer={
        <>
          <PrimaryButton disabled={!ready || saving} onClick={() => void save()}>
            {saving && <Spinner />}
            {saving ? "Saving" : "Save visit"}
          </PrimaryButton>
          <p className="m-0 mt-2 text-center text-[14px] text-muted-foreground">
            Each one becomes an Action with a due date (Urgent: 7 days, Soon: 30 days).
          </p>
        </>
      }
    >
      {form.isPending ? (
        <Loading />
      ) : form.error ? (
        <ErrorBox message={form.error.message} onRetry={() => void form.refetch()} />
      ) : (
        <>
          <div>
            <FieldLabel htmlFor="who">Who came?</FieldLabel>
            {adding ? (
              <TextInput
                id="who"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Company name"
                autoComplete="organization"
              />
            ) : (
              <SelectBox
                id="who"
                value={who}
                onChange={setWho}
                options={form.data.contractors.map((c) => ({ value: c.id, label: c.name }))}
                placeholder="Choose the contractor"
              />
            )}
            <p className="m-0 mt-1.5 text-[14px] text-muted-foreground">
              {adding ? (
                <button type="button" className="min-h-10 font-medium text-link" onClick={() => setAdding(false)}>
                  Choose from the list instead
                </button>
              ) : (
                <>
                  Not listed?{" "}
                  <button type="button" className="min-h-10 font-medium text-link" onClick={() => setAdding(true)}>
                    Add a new contractor
                  </button>
                </>
              )}
            </p>
          </div>

          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2 p-0 text-[16px] font-semibold">What for?</legend>
            <div className="flex flex-wrap gap-2">
              {form.data.purposes.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  aria-pressed={purpose === p.label}
                  onClick={() => setPurpose(p.label)}
                  className={cn(
                    "h-11 rounded-full border px-4 text-[15px] font-medium",
                    purpose === p.label ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {chosen?.links_to && (
              <p className="m-0 mt-2 text-[14px] text-muted-foreground">
                Links to the "{chosen.links_to}" check, so it counts as done.
              </p>
            )}
          </fieldset>

          <div>
            <FieldLabel htmlFor="cert">Certificate or report</FieldLabel>
            {file ? (
              <div className="flex min-h-[60px] items-center gap-3 rounded-xl border border-divider bg-surface px-3.5 py-2.5">
                <FileText aria-hidden className="size-5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15.5px]">{file.name}</div>
                  <div className="text-[13px] text-muted-foreground">
                    {fmtSize(file.size)} · {uploading ? "uploading" : "uploaded"}
                  </div>
                </div>
                {uploading ? (
                  <Spinner />
                ) : (
                  <>
                    <span className="flex size-7 items-center justify-center rounded-full bg-st-green-bg text-st-green">
                      <Check aria-label="Uploaded" className="size-4" />
                    </span>
                    <button
                      type="button"
                      aria-label="Remove file"
                      onClick={() => {
                        setFile(null)
                        setUploaded(null)
                      }}
                      className="flex size-10 items-center justify-center rounded-full text-muted-foreground"
                    >
                      <X aria-hidden className="size-4" />
                    </button>
                  </>
                )}
              </div>
            ) : (
              <label className="flex h-12 cursor-pointer items-center justify-center rounded-xl border border-dashed border-subtle bg-surface text-[15.5px] font-semibold">
                Upload the PDF or a photo of it
                <input
                  id="cert"
                  type="file"
                  accept="application/pdf,image/*"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ""
                    if (f) void pick(f)
                  }}
                />
              </label>
            )}
          </div>

          <div>
            <FieldLabel id="wrong-l">Did they find anything wrong?</FieldLabel>
            <Choice
              labelledBy="wrong-l"
              value={anyWrong}
              onChange={setAnyWrong}
              options={[
                { value: "no", label: "No" },
                { value: "yes", label: "Yes" },
              ]}
            />
          </div>

          {anyWrong === "yes" && (
            <div className="rounded-xl border border-divider bg-surface px-3.5 py-3">
              <div className="mb-2 text-[16px] font-semibold">
                {realFixes.length} thing{realFixes.length === 1 ? "" : "s"} to fix
              </div>
              <div className="flex flex-col gap-3">
                {fixes.map((f, i) => (
                  <div key={i} className="flex flex-col gap-1.5">
                    <div className="flex gap-1.5" role="group" aria-label={`Priority for fix ${i + 1}`}>
                      {(["high", "med"] as const).map((p) => (
                        <button
                          key={p}
                          type="button"
                          aria-pressed={f.priority === p}
                          onClick={() => setFixes((all) => all.map((x, j) => (j === i ? { ...x, priority: p } : x)))}
                          className={cn(
                            "h-10 rounded-full px-3.5 text-[14px] font-semibold",
                            f.priority === p
                              ? p === "high"
                                ? "bg-st-red-bg text-st-red ring-2 ring-st-red"
                                : "bg-st-amber-bg text-st-amber ring-2 ring-st-amber"
                              : "border border-border text-muted-foreground",
                          )}
                        >
                          {p === "high" ? "Urgent" : "Soon"}
                        </button>
                      ))}
                      {fixes.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Remove fix ${i + 1}`}
                          className="ml-auto flex size-10 items-center justify-center text-muted-foreground"
                          onClick={() => setFixes((all) => all.filter((_, j) => j !== i))}
                        >
                          <X aria-hidden className="size-4" />
                        </button>
                      )}
                    </div>
                    <TextInput
                      aria-label={`Fix ${i + 1}: what needs fixing`}
                      value={f.text}
                      onChange={(e) => setFixes((all) => all.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                      placeholder="Detector in room 7 faulty. Replace."
                    />
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="mt-2 min-h-11 text-[15px] font-semibold text-link"
                onClick={() => setFixes((all) => [...all, { text: "", priority: "med" }])}
              >
                + Add another
              </button>
            </div>
          )}
        </>
      )}
    </FlowScreen>
  )
}
