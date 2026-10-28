/*
 * Settings › Property details (PRD §6 Admin CMS › Properties): a property's legal frame and the features that decide
 * which checks apply (CMS-10), its geofence, licences and their conditions (CMS-11), locations and QR labels, and
 * legal hold (AUD-04). Adding a property starts here; its checks are then chosen in Property setup.
 */
import { Link, useNavigate, useParams as useRouteParams } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, QrCode } from "lucide-react"
import * as React from "react"

import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import {
  Breadcrumb,
  Callout,
  Card,
  ErrorState,
  LoadingPage,
  NoPermission,
  PageHeader,
} from "@bide-comply/ui/components/page"
import { toast } from "@bide-comply/ui/components/toaster"

import { fmtDate } from "@/lib/format"
import { useMe } from "@/lib/session"

type Licence = {
  id: string
  type: string
  number: string | null
  authority: string | null
  issued_on: string | null
  expires_on: string | null
  max_occupancy: number | null
  conditions: { text: string; kind: string }[]
}
type Detail = {
  id: string
  name: string
  code: string
  town: string | null
  dutyholder_id: string | null
  dutyholder: string | null
  jurisdiction: string
  local_authority: string | null
  licence_regime: string
  stage: string
  stage_note: string | null
  opening_date: string | null
  trading_since: string | null
  features: Record<string, boolean>
  feature_labels: Record<string, string>
  geofence: { lat: number | null; lng: number | null; radius_m: number | null }
  legal_hold: boolean
  licences: Licence[]
  locations: { id: string; name: string; type: string; qr_code: string | null; active: boolean }[]
  location_types: { key: string; name: string }[]
  dutyholders: { id: string; name: string }[]
}

const field = "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13.5px]"
const lbl = "flex flex-col gap-1 text-xs font-medium text-ink2"

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className={lbl}>
      {label}
      {children}
      {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function PropertyDetailsPage() {
  const { code } = useRouteParams({ strict: false }) as { code?: string }
  const me = useMe().data
  const navigate = useNavigate()
  const qc = useQueryClient()
  const isNew = !code || code === "new"
  const q = useQuery({
    queryKey: ["property-admin", code],
    queryFn: () => api.get<Detail>(`/api/admin/properties/${code}`),
    enabled: !isNew,
  })
  const [form, setForm] = React.useState<Partial<Detail> & Record<string, unknown>>({})
  React.useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))
  const save = useMutation({
    mutationFn: () => {
      const g = (form.geofence ?? {}) as Detail["geofence"]
      const body = {
        name: form.name,
        code: isNew ? form.code : undefined,
        town: form.town || null,
        dutyholder_id: form.dutyholder_id || null,
        jurisdiction: form.jurisdiction ?? "scotland",
        local_authority: form.local_authority || null,
        licence_regime: form.licence_regime ?? "class7_hotel",
        stage: form.stage ?? "setup",
        stage_note: form.stage_note || null,
        opening_date: form.opening_date || null,
        trading_since: form.trading_since || null,
        features: form.features ?? {},
        geofence_lat: g.lat ?? null,
        geofence_lng: g.lng ?? null,
        geofence_radius_m: g.radius_m ?? null,
        legal_hold: me?.roles.includes("super_admin") ? form.legal_hold : undefined,
      }
      return isNew
        ? api.post<{ code?: string }>("/api/admin/properties", body)
        : api.patch<{ code?: string }>(`/api/admin/properties/${code}`, body)
    },
    onSuccess: (r) => {
      toast(isNew ? "Property added. Next, choose its checks." : "Saved")
      void qc.invalidateQueries()
      if (isNew && r.code) void navigate({ to: `/settings/setup/${r.code}` })
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Couldn't save. Try again."),
  })
  if (!me) return <LoadingPage />
  if (!me.can["settings.view"]) return <NoPermission />
  if (!isNew && q.isLoading) return <LoadingPage />
  if (!isNew && q.error) return <ErrorState onRetry={() => void q.refetch()} />
  const d = q.data
  const labels = d?.feature_labels ?? {}
  const features = (form.features ?? {}) as Record<string, boolean>
  const g = (form.geofence ?? { lat: null, lng: null, radius_m: 150 }) as Detail["geofence"]
  const canEdit = me.can["register.toggle"]
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5">
      <Breadcrumb
        items={[
          { label: "Settings" },
          { label: "Property details", href: "/settings/properties" },
          { label: isNew ? "New property" : (d?.name ?? "") },
        ]}
      />
      <PageHeader
        title={isNew ? "Add a property" : `${d?.name} · details`}
        subtitle="The legal frame and the features that decide which checks apply here. Choose who does each check in Property setup."
        actions={
          <>
            {!isNew && (
              <Button variant="secondary" asChild>
                <Link to={`/settings/setup/${code}`}>Property setup</Link>
              </Button>
            )}
            <Button
              disabled={!canEdit || save.isPending || !form.name || (isNew && !form.code)}
              onClick={() => save.mutate()}
            >
              {isNew ? "Add property" : "Save changes"}
            </Button>
          </>
        }
      />
      {form.legal_hold && (
        <Callout tone="amber">
          Legal hold is on. Nothing at this property can be removed by the retention jobs until it's lifted.
        </Callout>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Property" bodyClassName="grid grid-cols-2 gap-3 p-4">
          <Field label="Name">
            <input className={field} value={String(form.name ?? "")} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field
            label="Code"
            hint={isNew ? "2–4 letters. Starts every ID here, like TV-014." : "Fixed once the register has IDs."}
          >
            <input
              className={field}
              value={String(form.code ?? "")}
              disabled={!isNew}
              onChange={(e) => set("code", e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Town">
            <input className={field} value={String(form.town ?? "")} onChange={(e) => set("town", e.target.value)} />
          </Field>
          <Field label="Dutyholder (SPV)">
            <select
              className={field}
              value={String(form.dutyholder_id ?? "")}
              onChange={(e) => set("dutyholder_id", e.target.value)}
            >
              <option value="">To confirm</option>
              {(d?.dutyholders ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Jurisdiction" hint="Scotland: Fire (Scotland) Act 2005. England: RR(FS)O 2005.">
            <select
              className={field}
              value={String(form.jurisdiction ?? "scotland")}
              onChange={(e) => set("jurisdiction", e.target.value)}
            >
              <option value="scotland">Scotland</option>
              <option value="england">England</option>
            </select>
          </Field>
          <Field label="Local authority">
            <input
              className={field}
              value={String(form.local_authority ?? "")}
              onChange={(e) => set("local_authority", e.target.value)}
            />
          </Field>
          <Field label="Licence regime">
            <select
              className={field}
              value={String(form.licence_regime ?? "class7_hotel")}
              onChange={(e) => set("licence_regime", e.target.value)}
            >
              <option value="class7_hotel">Class 7 hotel</option>
              <option value="stl">Short-term let</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Stage">
            <select
              className={field}
              value={String(form.stage ?? "setup")}
              onChange={(e) => set("stage", e.target.value)}
            >
              <option value="setup">Not set up yet</option>
              <option value="pre_opening">Opening soon</option>
              <option value="trading">Trading</option>
              <option value="closed">Closed</option>
            </select>
          </Field>
          <Field label="Opening date">
            <input
              type="date"
              className={field}
              value={String(form.opening_date ?? "")}
              onChange={(e) => set("opening_date", e.target.value)}
            />
          </Field>
          <Field label="Trading since">
            <input
              type="date"
              className={field}
              value={String(form.trading_since ?? "")}
              onChange={(e) => set("trading_since", e.target.value)}
            />
          </Field>
        </Card>
        <Card title="What this property has" bodyClassName="p-4">
          <p className="mt-0 mb-3 text-[13px] text-muted-foreground">
            Templates use these to decide whether they apply. A new property gets the matching templates proposed in
            Property setup.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(labels).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-[13.5px]">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--c-primary)]"
                  checked={!!features[k]}
                  onChange={(e) => set("features", { ...features, [k]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
          <h3 className="mt-5 mb-2 text-[13px] font-semibold">Location check (geofence)</h3>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Latitude">
              <input
                className={field}
                inputMode="decimal"
                value={g.lat ?? ""}
                onChange={(e) => set("geofence", { ...g, lat: e.target.value ? Number(e.target.value) : null })}
              />
            </Field>
            <Field label="Longitude">
              <input
                className={field}
                inputMode="decimal"
                value={g.lng ?? ""}
                onChange={(e) => set("geofence", { ...g, lng: e.target.value ? Number(e.target.value) : null })}
              />
            </Field>
            <Field label="Radius (m)" hint="Default 150 m">
              <input
                className={field}
                inputMode="numeric"
                value={g.radius_m ?? ""}
                onChange={(e) => set("geofence", { ...g, radius_m: e.target.value ? Number(e.target.value) : null })}
              />
            </Field>
          </div>
          <p className="mb-0 text-xs text-muted-foreground">
            Read once when a check is sent, never tracked. Outside submissions are allowed and flagged for review.
          </p>
          {me.roles.includes("super_admin") && !isNew && (
            <label className="mt-4 flex items-center gap-2 text-[13.5px]">
              <input
                type="checkbox"
                className="size-4 accent-[var(--c-primary)]"
                checked={!!form.legal_hold}
                onChange={(e) => set("legal_hold", e.target.checked)}
              />
              Legal hold (suspends deletion, e.g. during an incident or claim)
            </label>
          )}
        </Card>
      </div>
      {!isNew && d && <Licences d={d} />}
      {!isNew && d && <Locations d={d} />}
    </div>
  )
}

function Licences({ d }: { d: Detail }) {
  const qc = useQueryClient()
  const [adding, setAdding] = React.useState(false)
  const [f, setF] = React.useState({
    type: "premises",
    number: "",
    authority: "",
    issued_on: "",
    expires_on: "",
    max_occupancy: "",
    conditions: "",
  })
  const add = useMutation({
    mutationFn: () =>
      api.post(`/api/admin/properties/${d.code}/licences`, {
        type: f.type,
        number: f.number || null,
        authority: f.authority || null,
        issued_on: f.issued_on || null,
        expires_on: f.expires_on || null,
        max_occupancy: f.max_occupancy ? Number(f.max_occupancy) : null,
        conditions: f.conditions
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => ({ text: t.replace(/^local:\s*/i, ""), kind: /^local:/i.test(t) ? "local" : "mandatory" })),
      }),
    onSuccess: () => {
      setAdding(false)
      toast("Licence added")
      void qc.invalidateQueries({ queryKey: ["property-admin", d.code] })
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Couldn't save."),
  })
  return (
    <Card
      title="Licences and conditions"
      action={
        <Button size="sm" variant="secondary" onClick={() => setAdding((a) => !a)}>
          <Plus className="size-3.5" /> Add a licence
        </Button>
      }
    >
      {d.licences.length === 0 && !adding && (
        <p className="m-0 p-4 text-[13px] text-muted-foreground">
          No licences recorded. Class 7 hotels are normally outside short-term let licensing (gate item A03 confirms
          it).
        </p>
      )}
      {d.licences.map((l) => (
        <div key={l.id} className="border-b border-divider p-4 last:border-0">
          <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
            <strong className="font-semibold">
              {{ stl: "Short-term let licence", premises: "Premises licence", other: "Licence" }[l.type] ?? l.type}
            </strong>
            {l.number && <span className="mono-id">{l.number}</span>}
            <span className="text-muted-foreground">
              {[
                l.authority,
                l.expires_on && `expires ${fmtDate(l.expires_on, true)}`,
                l.max_occupancy && `max ${l.max_occupancy} guests`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          {l.conditions.length > 0 && (
            <ul className="mt-2 mb-0 pl-5 text-[13px]">
              {l.conditions.map((c, i) => (
                <li key={i}>
                  {c.text} <span className="text-xs text-muted-foreground">({c.kind})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {adding && (
        <form
          className="grid grid-cols-2 gap-3 border-t border-divider p-4 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault()
            add.mutate()
          }}
        >
          <Field label="Type">
            <select className={field} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="premises">Premises licence</option>
              <option value="stl">Short-term let licence</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Number">
            <input className={field} value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
          </Field>
          <Field label="Authority">
            <input className={field} value={f.authority} onChange={(e) => setF({ ...f, authority: e.target.value })} />
          </Field>
          <Field label="Issued">
            <input
              type="date"
              className={field}
              value={f.issued_on}
              onChange={(e) => setF({ ...f, issued_on: e.target.value })}
            />
          </Field>
          <Field label="Expires">
            <input
              type="date"
              className={field}
              value={f.expires_on}
              onChange={(e) => setF({ ...f, expires_on: e.target.value })}
            />
          </Field>
          <Field label="Maximum occupancy">
            <input
              className={field}
              inputMode="numeric"
              value={f.max_occupancy}
              onChange={(e) => setF({ ...f, max_occupancy: e.target.value })}
            />
          </Field>
          <label className={`${lbl} col-span-full`}>
            Conditions, one per line (start a line with "local:" for a local condition)
            <textarea
              rows={4}
              className="rounded-md border border-border bg-surface p-2.5 text-[13.5px] font-normal"
              value={f.conditions}
              onChange={(e) => setF({ ...f, conditions: e.target.value })}
            />
          </label>
          <div className="col-span-full flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending}>
              Add licence
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}

function Locations({ d }: { d: Detail }) {
  const qc = useQueryClient()
  const [name, setName] = React.useState("")
  const [type, setType] = React.useState("call_point")
  const add = useMutation({
    mutationFn: () => api.post(`/api/admin/properties/${d.code}/locations`, { name, type }),
    onSuccess: () => {
      setName("")
      void qc.invalidateQueries({ queryKey: ["property-admin", d.code] })
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Couldn't add it."),
  })
  const typeName = Object.fromEntries(d.location_types.map((t) => [t.key, t.name]))
  return (
    <Card
      title="Locations and assets"
      action={
        <span className="text-xs text-muted-foreground">Call points rotate in this order in the weekly alarm test</span>
      }
    >
      <table className="w-full text-[13.5px]">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="border-b border-divider px-4 py-2 font-medium">Name</th>
            <th className="border-b border-divider px-4 py-2 font-medium">Type</th>
            <th className="border-b border-divider px-4 py-2 font-medium">QR label</th>
          </tr>
        </thead>
        <tbody>
          {d.locations.map((l) => (
            <tr key={l.id}>
              <td className="border-b border-divider px-4 py-2">{l.name}</td>
              <td className="border-b border-divider px-4 py-2 text-muted-foreground">{typeName[l.type] ?? l.type}</td>
              <td className="border-b border-divider px-4 py-2">
                <a
                  href={`/api/admin/locations/${l.id}/qr.svg`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[13px]"
                >
                  <QrCode className="size-3.5" /> Print label
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="flex flex-wrap items-end gap-2 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) add.mutate()
        }}
      >
        <label className={`${lbl} min-w-[240px] flex-1`}>
          Add a location
          <input
            className={field}
            placeholder="e.g. CP6 · Second floor rear"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className={lbl}>
          Type
          <select className={field} value={type} onChange={(e) => setType(e.target.value)}>
            {d.location_types.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary" disabled={!name.trim() || add.isPending}>
          Add
        </Button>
      </form>
    </Card>
  )
}

export function PropertyListAdmin() {
  const me = useMe().data
  if (!me) return <LoadingPage />
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-5">
      <PageHeader
        title="Property details"
        subtitle="Each property's legal frame, features, geofence, licences and locations."
        actions={
          me.can["register.toggle"] && (
            <Button asChild>
              <Link to="/settings/properties/new">Add a property</Link>
            </Button>
          )
        }
      />
      <Card>
        <ul className="m-0 list-none p-0">
          {me.properties.map((p) => (
            <li key={p.id} className="border-b border-divider last:border-0">
              <Link
                to={`/settings/properties/${p.code}`}
                className="flex items-center gap-3 px-4 py-3 text-foreground no-underline hover:bg-hover"
              >
                <span className="inline-flex h-6 w-8 items-center justify-center rounded bg-hover text-[11px] font-semibold">
                  {p.code}
                </span>
                <span className="flex-1 font-medium">{p.name}</span>
                <span className="text-[13px] text-muted-foreground">{p.town}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
