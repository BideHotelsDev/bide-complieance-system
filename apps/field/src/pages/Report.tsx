/*
 * Report something (design: AppReport). Something broken or unsafe becomes an Action (EXE-09); someone hurt, or nearly,
 * is an incident with the RIDDOR question (EXE-12); the fire alarm going off is an alarm event (EXE-15).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { api, ApiError } from "@bide-comply/api-client"
import { toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"
import { Bell, CirclePlus, TriangleAlert, X } from "lucide-react"
import * as React from "react"

import { Camera } from "@/components/Camera"
import {
  Choice,
  FieldLabel,
  FlowScreen,
  PrimaryButton,
  SelectBox,
  Spinner,
  TextArea,
  TextInput,
} from "@/components/kit"
import { toastCouldntSave, toastSent } from "@/components/sync"
import { shortName } from "@/lib/format"
import { useMe, useProperty } from "@/lib/session"
import { useShots } from "@/lib/shots"
import type { Location } from "@/lib/types"

type Kind = "hazard" | "hurt" | "alarm"

const KINDS: { value: Kind; title: string; hint: string; icon: React.ReactNode }[] = [
  {
    value: "hazard",
    title: "Something is broken or unsafe",
    hint: "A door, light, appliance, trip hazard",
    icon: <TriangleAlert aria-hidden className="size-5" />,
  },
  {
    value: "hurt",
    title: "Someone was hurt, or nearly",
    hint: "Accident or near miss",
    icon: <CirclePlus aria-hidden className="size-5" />,
  },
  {
    value: "alarm",
    title: "The fire alarm went off",
    hint: "Real or false alarm",
    icon: <Bell aria-hidden className="size-5" />,
  },
]

const CAUSES = [
  "Cooking or burnt food",
  "Steam from a shower",
  "Aerosol, vaping or smoking",
  "Dust from works",
  "Detector or system fault",
  "Call point pressed by mistake",
  "Malicious",
  "Real fire",
  "Not known",
]
const ARC = [
  "Alarm company phoned the keyholder",
  "Fire service came out",
  "Fire service called off",
  "No call from the alarm company",
  "Not monitored",
]

// Same words the server uses to decide a report is life safety (field.py LIFE_SAFETY_WORDS).
const LIFE = ["fire door", "door doesn't close", "exit", "escape", "alarm", "smoke", "emergency light", "extinguisher"]

const OTHER = "__other__"

export function ReportPage() {
  const me = useMe()
  const { propertyId } = useProperty()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [kind, setKind] = React.useState<Kind>("hazard")
  const [where, setWhere] = React.useState("")
  const [whereText, setWhereText] = React.useState("")
  const [text, setText] = React.useState("")
  const [hurt, setHurt] = React.useState<"accident" | "near_miss" | null>(null)
  const [people, setPeople] = React.useState("")
  const [riddor, setRiddor] = React.useState<"yes" | "no" | null>(null)
  const [zone, setZone] = React.useState("")
  const [cause, setCause] = React.useState("")
  const [falseAlarm, setFalseAlarm] = React.useState<"yes" | "no" | null>(null)
  const [arc, setArc] = React.useState("")
  const [minutes, setMinutes] = React.useState("")
  const [camera, setCamera] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const property = me.data?.properties.find((p) => p.id === propertyId)
  const { shots, add, remove, ensureUploaded } = useShots({ property_id: propertyId, ref: property?.code })
  const locations = useQuery({
    queryKey: ["locations", propertyId],
    queryFn: () => api.get<Location[]>("/api/field/locations", { property: propertyId }),
    enabled: Boolean(propertyId),
  })
  const locName = where === OTHER ? whereText : (locations.data?.find((l) => l.id === where)?.name ?? "")
  const life = kind === "hazard" && LIFE.some((w) => `${locName} ${text}`.toLowerCase().includes(w))

  const ready =
    kind === "alarm"
      ? Boolean(cause && falseAlarm)
      : Boolean(text.trim()) && (kind === "hazard" || Boolean(hurt && riddor))

  const send = async () => {
    if (!propertyId) return
    setSending(true)
    try {
      const up = await ensureUploaded()
      if (up.status !== "done") {
        if (up.status === "offline") toastCouldntSave(() => void send())
        else toastError("A photo didn't finish uploading. Take it again.")
        return
      }
      const res = await api.post<{ message: string }>("/api/field/reports", {
        kind: kind === "hurt" ? hurt : kind,
        property_id: propertyId,
        location_id: where && where !== OTHER ? where : null,
        location_text: where === OTHER ? whereText : null,
        description: text,
        photos: up.shots.map((s) => s.evidence_id).filter(Boolean),
        riddor: riddor === "yes",
        people_involved: people || null,
        zone: zone || locName || null,
        cause: cause || null,
        false_alarm: falseAlarm !== "no",
        arc_response: arc || null,
        attended_minutes: minutes ? Number(minutes) : null,
      })
      toastSent(res.message)
      void qc.invalidateQueries({ queryKey: ["today"] })
      void navigate({ to: "/" })
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) toastCouldntSave(() => void send())
      else toastError(e instanceof Error ? e.message : "Couldn't send. Try again.")
    } finally {
      setSending(false)
    }
  }

  const locOptions = [
    ...(locations.data ?? []).map((l) => ({ value: l.id, label: l.name })),
    { value: OTHER, label: "Somewhere else" },
  ]

  return (
    <FlowScreen
      title="Report something"
      footer={
        <>
          <PrimaryButton disabled={!ready || sending} onClick={() => void send()}>
            {sending && <Spinner />}
            {sending ? "Sending" : "Send report"}
          </PrimaryButton>
          {life && (
            <p className="m-0 mt-2 text-center text-[14px] text-muted-foreground">
              This sounds like life safety. Your manager will be told straight away.
            </p>
          )}
          {kind === "hurt" && riddor === "yes" && (
            <p className="m-0 mt-2 text-center text-[14px] text-muted-foreground">
              This may need reporting to the HSE (RIDDOR). Your manager will be told straight away.
            </p>
          )}
        </>
      }
    >
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-2 p-0 text-[16px] font-semibold">What happened?</legend>
        <div className="flex flex-col gap-2">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              aria-pressed={kind === k.value}
              onClick={() => setKind(k.value)}
              className={cn(
                "flex min-h-[64px] items-center gap-3.5 rounded-xl border bg-surface px-4 py-3 text-left",
                kind === k.value ? "border-2 border-foreground" : "border-border",
              )}
            >
              {k.icon}
              <span>
                <span className="block text-[16px] font-semibold">{k.title}</span>
                <span className="block text-[14px] text-muted-foreground">{k.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      {kind === "hurt" && (
        <>
          <div>
            <FieldLabel id="hurt-l">Was someone hurt?</FieldLabel>
            <Choice
              labelledBy="hurt-l"
              value={hurt}
              onChange={setHurt}
              options={[
                { value: "accident", label: "Yes, hurt" },
                { value: "near_miss", label: "No, nearly" },
              ]}
            />
          </div>
          <div>
            <FieldLabel htmlFor="people">Who was involved?</FieldLabel>
            <TextInput
              id="people"
              value={people}
              onChange={(e) => setPeople(e.target.value)}
              placeholder="A guest, a member of staff, a contractor"
            />
          </div>
          <div>
            <FieldLabel
              id="riddor-l"
              help="For example a broken bone, or they can't do their normal work for more than 7 days."
            >
              Did they go to hospital, or will they be off work?
            </FieldLabel>
            <Choice
              labelledBy="riddor-l"
              value={riddor}
              onChange={setRiddor}
              options={[
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ]}
            />
          </div>
        </>
      )}

      {kind === "alarm" ? (
        <>
          <div>
            <FieldLabel htmlFor="zone" help="As shown on the fire panel">
              Zone or detector
            </FieldLabel>
            <TextInput id="zone" value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Zone 2, room 7" />
          </div>
          <div>
            <FieldLabel htmlFor="cause">What set it off?</FieldLabel>
            <SelectBox
              id="cause"
              value={cause}
              onChange={setCause}
              options={CAUSES.map((c) => ({ value: c, label: c }))}
            />
          </div>
          <div>
            <FieldLabel id="false-l">Was it a false alarm?</FieldLabel>
            <Choice
              labelledBy="false-l"
              value={falseAlarm}
              onChange={setFalseAlarm}
              options={[
                { value: "yes", label: "Yes, false" },
                { value: "no", label: "No, real" },
              ]}
            />
          </div>
          <div>
            <FieldLabel htmlFor="arc">What did the alarm company do?</FieldLabel>
            <SelectBox id="arc" value={arc} onChange={setArc} options={ARC.map((c) => ({ value: c, label: c }))} />
          </div>
          <div>
            <FieldLabel htmlFor="mins" help="Leave empty if no keyholder came">
              Keyholder arrived after
            </FieldLabel>
            <div className="relative">
              <TextInput
                id="mins"
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))}
                className="tabular pr-24"
              />
              <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[16px] text-muted-foreground">
                minutes
              </span>
            </div>
          </div>
        </>
      ) : (
        <div>
          <FieldLabel htmlFor="where">Where?</FieldLabel>
          <SelectBox id="where" value={where} onChange={setWhere} options={locOptions} placeholder="Choose a place" />
          {where === OTHER && (
            <TextInput
              aria-label="Where, in your words"
              className="mt-2"
              value={whereText}
              onChange={(e) => setWhereText(e.target.value)}
              placeholder="Room 104, back stairs"
            />
          )}
        </div>
      )}

      <div>
        <FieldLabel htmlFor="desc">
          {kind === "hazard" ? "What's wrong?" : kind === "hurt" ? "What happened?" : "Anything else?"}
        </FieldLabel>
        <TextArea id="desc" aria-label="Description" value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      <div>
        <div className="mb-2 text-[16px] font-semibold">Photo</div>
        <div className="flex flex-wrap gap-2.5">
          {shots.map((s) => (
            <div key={s.id} className="relative size-[88px] overflow-hidden rounded-xl bg-hover">
              <img src={s.url} alt="Report photo" className="size-full object-cover" />
              <button
                type="button"
                aria-label="Remove photo"
                onClick={() => remove(s.id)}
                className="absolute top-1 right-1 flex size-8 items-center justify-center rounded-full bg-black/60 text-white"
              >
                <X aria-hidden className="size-4" />
              </button>
              {s.status === "uploading" && (
                <span className="absolute bottom-1 left-1 rounded-full bg-black/60 p-1 text-white">
                  <Spinner className="size-3" />
                </span>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setCamera(true)}
            className="flex size-[88px] items-center justify-center rounded-xl border border-dashed border-subtle bg-surface text-[15px] font-semibold"
          >
            + Photo
          </button>
        </div>
      </div>

      {camera && (
        <Camera
          title="Photo of the problem"
          hint="Show what's wrong and where it is"
          index={shots.length + 1}
          total={shots.length + 1}
          stampPrefix={`${property?.name ?? ""} · Report · ${shortName(me.data?.name ?? "")}`}
          onClose={() => setCamera(false)}
          onCapture={(blob, at) => {
            add("report", blob, at)
            setCamera(false)
          }}
        />
      )}
    </FlowScreen>
  )
}
