/*
 * Settings › People and roles (design: People). Who can do what, and at which property: the directory with each
 * person's roles and required training, a side panel to change roles, sign out devices, set up leave cover and
 * offboard; plus groups (pools), contractors and dutyholders.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, RefreshCw } from "lucide-react"
import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { DataTable, Pagination, type ColumnDef } from "@bide-comply/ui/components/data-table"
import { FilterBar, SearchBox, Summary, type Facet } from "@bide-comply/ui/components/filter-bar"
import {
  Avatar,
  Callout,
  EmptyState,
  ErrorState,
  LoadingRows,
  NoPermission,
  PageHeader,
  SideSheet,
} from "@bide-comply/ui/components/page"
import { Popover, PopoverContent, PopoverTrigger } from "@bide-comply/ui/components/popover"
import { Pill, type Tone } from "@bide-comply/ui/components/status"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { AssigneePicker, useAssignees } from "../../features/settings-a/assignee"
import { ActionDialog, errMsg, Labeled, NativeSelect, TextInput } from "../../features/settings-a/ui"
import { fmtDate, fmtDay, plural } from "../../lib/format"
import { list, useParams } from "../../lib/params"
import { useMe } from "../../lib/session"

type PersonRow = {
  id: string
  name: string
  initials: string
  title: string | null
  property: string
  roles: { role: string; label: string; property: string }[]
  training: string
  training_tone: "red" | "amber" | "green"
  last_active: string
}
type PeopleList = {
  rows: PersonRow[]
  total: number
  page: number
  page_size: number
  facets: Facet[]
  summary: string
  any_filter: boolean
  tabs: { people: number; groups: number; contractors: number; dutyholders: number }
}
type Detail = {
  id: string
  name: string
  initials: string
  email: string | null
  title: string | null
  kind: string
  roles: { id: string; role: string; label: string; property: string; property_id: string | null }[]
  requirements: { id: string; key: string; name: string; status: string; label: string; restricted: boolean }[]
  devices: { id: string; label: string; detail: string }[]
  items_named: number
  items_via_groups?: number
  can_manage: boolean
  first_name: string
}

const ROLES: { key: string; label: string; group?: boolean }[] = [
  { key: "staff", label: "Staff" },
  { key: "keyholder", label: "Keyholder" },
  { key: "site_lead", label: "Site lead" },
  { key: "assessor", label: "Competent assessor" },
  { key: "dutyholder", label: "Dutyholder" },
  { key: "register_keeper", label: "Register keeper", group: true },
  { key: "systems", label: "Systems", group: true },
  { key: "system_owner", label: "System owner", group: true },
  { key: "super_admin", label: "Super Admin", group: true },
]

const TABS = [
  { key: "people", label: "People" },
  { key: "groups", label: "Groups" },
  { key: "contractors", label: "Contractors" },
  { key: "dutyholders", label: "Dutyholders" },
] as const

export function PeoplePage() {
  const me = useMe()
  const [p, set] = useParams()
  const tab = (p.tab ?? "people") as (typeof TABS)[number]["key"]
  const canManage = !!me.data?.can["people.manage"]
  const people = useQuery({
    queryKey: ["people", p.q, p.prop, p.role, p.training, p.page],
    queryFn: () =>
      api.get<PeopleList>("/api/people", {
        q: p.q,
        prop: list(p.prop),
        role: list(p.role),
        training: list(p.training),
        page: Number(p.page ?? 1),
      }),
    placeholderData: (prev) => prev,
  })
  const [inviting, setInviting] = React.useState(false)
  const sync = useMutation({
    mutationFn: () => api.post<{ message?: string }>("/api/people/sync-google"),
    onSuccess: (r) => toast(r.message ?? "Synced from Google Workspace."),
    onError: (e) => toastError(errMsg(e)),
  })

  if (me.data && !me.data.can["people.view"]) return <NoPermission />
  if (people.error instanceof ApiError && people.error.status === 403) return <NoPermission />

  const tabs = people.data?.tabs
  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <PageHeader
          title="People and roles"
          subtitle="Who can do what, and at which property."
          actions={
            canManage && (
              <>
                <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
                  <RefreshCw className={cn(sync.isPending && "animate-spin")} aria-hidden />
                  Sync from Google
                </Button>
                <Button onClick={() => setInviting(true)}>Invite someone</Button>
              </>
            )
          }
        />
        <div role="tablist" aria-label="People and roles" className="flex gap-6 border-b border-divider">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => set({ tab: t.key === "people" ? undefined : t.key, sel: undefined, page: undefined })}
              className={cn(
                "-mb-px inline-flex h-10 items-center gap-2 border-b-2 text-[14px]",
                tab === t.key
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {tabs && (
                <span className="tabular rounded-full bg-hover px-1.5 text-[11.5px] font-semibold text-ink2">
                  {tabs[t.key]}
                </span>
              )}
            </button>
          ))}
        </div>
        {tab === "people" && <PeopleTab q={people} />}
        {tab === "groups" && <GroupsTab canManage={canManage} />}
        {tab === "contractors" && <ContractorsTab canManage={canManage} />}
        {tab === "dutyholders" && <DutyholdersTab />}
      </div>
      {tab === "people" && p.sel && <PersonPanel id={p.sel} onClose={() => set({ sel: undefined })} />}
      {inviting && (
        <InviteDialog onClose={() => setInviting(false)} onDone={(id) => set({ sel: id, tab: undefined })} />
      )}
    </div>
  )
}

const TONE: Record<string, Tone> = { red: "red", amber: "amber", green: "green" }

function PeopleTab({ q }: { q: ReturnType<typeof useQuery<PeopleList, Error>> }) {
  const [p, set] = useParams()
  const columns: ColumnDef<PersonRow, unknown>[] = [
    {
      id: "person",
      header: "Person",
      cell: ({ row: { original: r } }) => (
        <span className="flex items-center gap-2.5 py-1">
          <Avatar initials={r.initials} />
          <span className="min-w-0">
            <span className="block font-medium">{r.name}</span>
            <span className="block text-xs text-muted-foreground">{r.property}</span>
          </span>
        </span>
      ),
    },
    {
      id: "roles",
      header: "Roles",
      cell: ({ row: { original: r } }) => (
        <span className="flex flex-col items-start gap-1 py-1">
          {r.roles.map((x, i) => (
            <Pill key={i} tone="grey" className="rounded-md">
              {x.label} · {x.property}
            </Pill>
          ))}
        </span>
      ),
    },
    {
      id: "training",
      header: "Required training and checks",
      cell: ({ row: { original: r } }) => (
        <Pill tone={r.training === "Nothing required" ? "grey" : TONE[r.training_tone]}>{r.training}</Pill>
      ),
    },
    {
      id: "last",
      header: "Last active",
      cell: ({ row }) => <span className="text-ink2">{row.original.last_active}</span>,
    },
  ]
  return (
    <>
      <FilterBar
        facets={q.data?.facets ?? []}
        onFacet={(k, v) => set({ [k]: v.join(",") || undefined, page: undefined })}
        search={
          <SearchBox
            value={p.q ?? ""}
            onChange={(v) => set({ q: v || undefined, page: undefined })}
            placeholder="Search people"
          />
        }
        anyFilter={q.data?.any_filter}
        onClearAll={() => set({ q: undefined, prop: undefined, role: undefined, training: undefined, page: undefined })}
      />
      {q.data && <Summary>{q.data.summary}</Summary>}
      <div className="overflow-hidden rounded-[10px] border border-divider bg-surface">
        {q.error ? (
          <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <LoadingRows rows={6} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={q.data.rows}
              selectedId={p.sel}
              onRowClick={(r) => set({ sel: r.id })}
              caption="People"
              empty={
                <EmptyState title="No one matches">
                  {q.data.any_filter ? "Try fewer filters or a different search." : "Invite someone to get started."}
                </EmptyState>
              }
              mobileCard={(r) => (
                <span className="flex items-center gap-2.5">
                  <Avatar initials={r.initials} />
                  <span>
                    <span className="block font-medium">{r.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.roles.map((x) => x.label).join(", ")} · {r.training}
                    </span>
                  </span>
                </span>
              )}
            />
            {q.data.total > q.data.page_size && (
              <div className="border-t border-divider">
                <Pagination
                  page={q.data.page}
                  pageSize={q.data.page_size}
                  total={q.data.total}
                  noun="people"
                  onPage={(n) => set({ page: n === 1 ? undefined : String(n) })}
                />
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}

function coverText(d: Detail): string {
  const g = d.items_via_groups ?? 0
  if (d.items_named === 0 && g === 0) return `${d.first_name} isn't named on any checks yet.`
  const parts = [
    d.items_named ? `named on ${plural(d.items_named, "check")}` : null,
    g ? `in a group that does ${plural(g, "check")}` : null,
  ].filter(Boolean)
  return `${d.first_name} is ${parts.join(" and ")}. Someone else can do them while ${d.first_name} is away.`
}

const REQ_TONE: Record<string, Tone> = {
  ok: "green",
  expiring: "amber",
  expired: "red",
  missing: "red",
  pending: "blue",
}

function PersonPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const me = useMe()
  const q = useQuery({ queryKey: ["person", id], queryFn: () => api.get<Detail>(`/api/people/${id}`) })
  const [offboarding, setOffboarding] = React.useState(false)
  const [covering, setCovering] = React.useState(false)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["person", id] })
    void qc.invalidateQueries({ queryKey: ["people"] })
  }
  const removeRole = useMutation({
    mutationFn: (r: Detail["roles"][number]) => api.del(`/api/people/${id}/roles/${r.id}`),
    onSuccess: (_x, r) => {
      refresh()
      toast(`Removed ${r.label} at ${r.property}`)
    },
    onError: (e) => toastError(errMsg(e)),
  })
  const revoke = useMutation({
    mutationFn: (deviceId: string) => api.post(`/api/people/${id}/devices/${deviceId}/revoke`),
    onSuccess: () => {
      refresh()
      toast("Signed out that device. They'll need to sign in again on it.")
    },
    onError: (e) => toastError(errMsg(e)),
  })
  const d = q.data
  const manage = !!d?.can_manage
  const isMe = me.data?.id === id
  return (
    <SideSheet
      label={d?.name ?? "Person"}
      onClose={onClose}
      className="lg:max-h-[calc(100vh-48px)] lg:w-[380px]"
      header={
        d && (
          <span className="flex min-w-0 items-center gap-2.5">
            <Avatar initials={d.initials} className="size-10 text-[13px]" />
            <span className="min-w-0">
              <span className="block truncate text-[16px] font-semibold">{d.name}</span>
              <span className="block truncate text-[13px] text-muted-foreground">
                {d.email ?? "No email"}
                {d.title ? ` · ${d.title}` : ""}
              </span>
            </span>
          </span>
        )
      }
      footer={
        d &&
        manage &&
        !isMe && (
          <div className="flex w-full flex-col gap-2">
            <Button
              variant="outline"
              className="w-full border-st-red/50 text-st-red hover:bg-st-red-bg"
              onClick={() => setOffboarding(true)}
            >
              Offboard {d.first_name}
            </Button>
            <p className="m-0 text-xs text-muted-foreground">
              Ends access straight away, signs out every device, and moves their checks to their cover person. Their
              past records stay.
            </p>
          </div>
        )
      }
    >
      {q.error ? (
        <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
      ) : !d ? (
        <LoadingRows rows={6} />
      ) : (
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-[12.5px] font-medium text-ink2">Roles</h3>
            {d.roles.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">No roles yet.</p>}
            {d.roles.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-lg border border-divider px-3 py-2.5">
                <span className="min-w-0 flex-1 text-[13.5px]">
                  <span className="font-medium">{r.label}</span>{" "}
                  <span className="text-muted-foreground">at {r.property}</span>
                </span>
                {manage && (
                  <button
                    type="button"
                    disabled={removeRole.isPending}
                    onClick={() => removeRole.mutate(r)}
                    className="text-[13px] text-link hover:underline"
                    aria-label={`Remove ${r.label} at ${r.property}`}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            {manage && <AddRole personId={id} onDone={refresh} />}
          </section>

          <section className="flex flex-col gap-1">
            <h3 className="m-0 mb-1 text-[12.5px] font-medium text-ink2">Required for these roles</h3>
            {d.requirements.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">Nothing required.</p>}
            {d.requirements.map((r) => (
              <div key={r.id} className="flex items-start gap-3 border-b border-divider py-2 last:border-0">
                <span className="min-w-0 flex-1 text-[13.5px]">{r.name}</span>
                <Pill
                  tone={REQ_TONE[r.status] ?? "grey"}
                  className={cn(
                    "max-w-[180px]",
                    r.label.length > 22 && "h-auto rounded-md py-1 text-left leading-snug whitespace-normal",
                  )}
                >
                  {r.label}
                </Pill>
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="m-0 text-[12.5px] font-medium text-ink2">Leave cover</h3>
            </div>
            <p className="m-0 text-[13px] text-muted-foreground">{coverText(d)}</p>
            {manage && (
              <Button variant="outline" size="sm" className="self-start" onClick={() => setCovering(true)}>
                Set up cover
              </Button>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-[12.5px] font-medium text-ink2">Trusted devices</h3>
            {d.devices.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">No trusted devices.</p>}
            {d.devices.map((dev) => (
              <div key={dev.id} className="flex items-center gap-3 rounded-lg border border-divider px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">{dev.label}</span>
                  <span className="block text-xs text-muted-foreground">{dev.detail}</span>
                </span>
                {manage && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-st-red/50 text-st-red hover:bg-st-red-bg"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(dev.id)}
                  >
                    Sign out
                  </Button>
                )}
              </div>
            ))}
          </section>
        </div>
      )}
      {d && offboarding && (
        <OffboardDialog
          person={d}
          onClose={() => setOffboarding(false)}
          onDone={() => {
            setOffboarding(false)
            void qc.invalidateQueries({ queryKey: ["people"] })
            onClose()
          }}
        />
      )}
      {d && covering && <CoverDialog person={d} onClose={() => setCovering(false)} />}
    </SideSheet>
  )
}

function AddRole({ personId, onDone }: { personId: string; onDone: () => void }) {
  const me = useMe()
  const [open, setOpen] = React.useState(false)
  const [role, setRole] = React.useState("staff")
  const props = me.data?.properties ?? []
  const [picked, setProp] = React.useState("")
  const prop = picked || props[0]?.id || ""
  const group = ROLES.find((r) => r.key === role)?.group
  const m = useMutation({
    mutationFn: () => api.post(`/api/people/${personId}/roles`, { role, property_id: group || !prop ? null : prop }),
    onSuccess: () => {
      setOpen(false)
      onDone()
      toast(`Added ${ROLES.find((r) => r.key === role)?.label}. Required training for it is now listed.`)
    },
    onError: (e) => toastError(errMsg(e)),
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="self-start">
          <Plus /> Add a role
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-72 flex-col gap-3 p-3">
        <Labeled label="Role" htmlFor="ar-role">
          <NativeSelect
            id="ar-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={ROLES.filter((r) => r.key !== "super_admin" || me.data?.roles.includes("super_admin")).map(
              (r) => ({
                value: r.key,
                label: r.label,
              }),
            )}
          />
        </Labeled>
        <Labeled label="Where" htmlFor="ar-prop" hint={group ? "Group roles cover every property." : undefined}>
          <NativeSelect
            id="ar-prop"
            value={group ? "" : prop}
            disabled={group}
            onChange={(e) => setProp(e.target.value)}
            options={
              group ? [{ value: "", label: "All properties" }] : props.map((x) => ({ value: x.id, label: x.name }))
            }
          />
        </Labeled>
        <Button disabled={m.isPending} onClick={() => m.mutate()}>
          {m.isPending ? "Adding…" : "Add role"}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function OffboardDialog({ person: d, onClose, onDone }: { person: Detail; onClose: () => void; onDone: () => void }) {
  const m = useMutation({
    mutationFn: () => api.post<{ moved_to_cover: number; needs_owner: number }>(`/api/people/${d.id}/offboard`),
    onSuccess: (r) => {
      toast(
        `${d.name} is offboarded. ${plural(r.moved_to_cover, "check")} moved to cover${
          r.needs_owner ? `; ${plural(r.needs_owner, "check")} need a new owner` : ""
        }.`,
      )
      onDone()
    },
    onError: (e) => toastError(errMsg(e)),
  })
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={m.isPending}
      title={`Offboard ${d.first_name}?`}
      subtitle={`${d.name}${d.roles[0] ? ` · ${d.roles.map((r) => `${r.label} at ${r.property}`).join(", ")}` : ""}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? "Offboarding…" : `Offboard ${d.first_name}`}
          </Button>
        </>
      }
    >
      <p className="m-0">This happens straight away:</p>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
        <li>Ends {d.first_name}'s access to bide Comply and the staff app</li>
        <li>
          Signs out every device
          {d.devices.length ? ` (${plural(d.devices.length, "trusted device")})` : ""}
        </li>
        <li>
          {d.items_named > 0
            ? `Moves the ${plural(d.items_named, "check")} ${d.first_name} is named on to their cover person. Any without cover are marked "needs owner" and the system owner is told`
            : `${d.first_name} isn't named on any checks, so nothing needs moving`}
        </li>
        <li>Takes {d.first_name} out of every group</li>
        <li>Keeps every past record, with {d.first_name}'s name on it</li>
      </ul>
      <Callout tone="grey">This can't be undone here. To bring someone back, invite them again.</Callout>
    </ActionDialog>
  )
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function CoverDialog({ person: d, onClose }: { person: Detail; onClose: () => void }) {
  const props = d.roles.filter((r) => r.property_id)
  const [propertyId, setPropertyId] = React.useState(props[0]?.property_id ?? "")
  const assignees = useAssignees(propertyId || null)
  const [cover, setCover] = React.useState<{ id: string; label: string } | null>(null)
  const today = new Date()
  const [from, setFrom] = React.useState(iso(today))
  const [until, setUntil] = React.useState(iso(new Date(today.getTime() + 11 * 86400000)))
  const [error, setError] = React.useState<string | null>(null)
  const m = useMutation({
    mutationFn: () =>
      api.post("/api/approvals/cover", {
        person_id: d.id,
        cover_id: cover?.id,
        starts_on: from,
        ends_on: until,
        property_id: propertyId,
      }),
    onSuccess: () => {
      toast(`${cover?.label} covers ${d.first_name}'s checks from ${fmtDay(from)} until ${fmtDay(until)}.`)
      onClose()
    },
    onError: (e) => setError(errMsg(e)),
  })
  const propName = props.find((r) => r.property_id === propertyId)?.property
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={m.isPending}
      title={`Cover ${d.first_name}'s checks`}
      subtitle={`${plural(d.items_named + (d.items_via_groups ?? 0), "check")}${propName ? ` at ${propName}` : ""}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!cover || !propertyId || until < from || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? "Setting up…" : "Set up cover"}
          </Button>
        </>
      }
    >
      {props.length === 0 ? (
        <Callout tone="amber">
          {d.first_name} has no role at a property, so there are no checks to cover. Add a role first.
        </Callout>
      ) : (
        <>
          {props.length > 1 && (
            <Labeled label="Property" htmlFor="cv-prop">
              <NativeSelect
                id="cv-prop"
                value={propertyId}
                onChange={(e) => setPropertyId(e.target.value)}
                options={props
                  .filter((r, i, a) => a.findIndex((x) => x.property_id === r.property_id) === i)
                  .map((r) => ({ value: r.property_id!, label: r.property }))}
              />
            </Labeled>
          )}
          <Labeled label="Who covers?" error={error}>
            <div className="rounded-md border border-border">
              <AssigneePicker
                label="Who covers"
                value={cover?.label ?? "Choose a person"}
                selected={cover ? { kind: "person", id: cover.id } : null}
                options={[{ kind: "person", items: assignees.person.filter((o) => o.id !== d.id) }]}
                onPick={(o) => {
                  setCover({ id: o.id, label: o.label })
                  setError(null)
                }}
              />
            </div>
          </Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="From" htmlFor="cv-from">
              <TextInput id="cv-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Labeled>
            <Labeled label="Until" htmlFor="cv-until" error={until < from ? "Until is before From." : undefined}>
              <TextInput
                id="cv-until"
                type="date"
                value={until}
                min={from}
                onChange={(e) => setUntil(e.target.value)}
              />
            </Labeled>
          </div>
          <p className="m-0 text-[13px] text-muted-foreground">
            Checks go back to {d.first_name} automatically. The cover is shown on the scorecard so nobody loses points.
          </p>
        </>
      )}
    </ActionDialog>
  )
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const me = useMe()
  const qc = useQueryClient()
  const props = me.data?.properties ?? []
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [title, setTitle] = React.useState("")
  const [role, setRole] = React.useState("staff")
  const [prop, setProp] = React.useState(props[0]?.id ?? "")
  const [error, setError] = React.useState<string | null>(null)
  const group = ROLES.find((r) => r.key === role)?.group
  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/api/people", {
        name,
        email,
        title: title || null,
        role,
        property_id: group ? null : prop || null,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["people"] })
      toast(`Added ${name.trim()}. They can sign in with Google using ${email.trim()}.`)
      onClose()
      onDone(r.id)
    },
    onError: (e) =>
      setError(
        e instanceof ApiError && e.status === 422 && /email/i.test(JSON.stringify(e.data))
          ? "Enter a valid email address."
          : errMsg(e),
      ),
  })
  const ok = name.trim().length > 1 && /.+@.+\..+/.test(email.trim())
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={m.isPending}
      title="Invite someone"
      subtitle="They sign in with their Google Workspace account. Required training follows the role."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? "Inviting…" : "Invite"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Labeled label="Name" htmlFor="iv-name">
          <TextInput id="iv-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Labeled>
        <Labeled label="Job title (optional)" htmlFor="iv-title">
          <TextInput
            id="iv-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Housekeeper"
          />
        </Labeled>
      </div>
      <Labeled label="Email" htmlFor="iv-email">
        <TextInput
          id="iv-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@bidehotels.com"
        />
      </Labeled>
      <div className="grid grid-cols-2 gap-3">
        <Labeled label="Role" htmlFor="iv-role">
          <NativeSelect
            id="iv-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={ROLES.filter((r) => r.key !== "super_admin").map((r) => ({ value: r.key, label: r.label }))}
          />
        </Labeled>
        <Labeled label="Where" htmlFor="iv-prop">
          <NativeSelect
            id="iv-prop"
            value={group ? "" : prop}
            disabled={group}
            onChange={(e) => setProp(e.target.value)}
            options={
              group ? [{ value: "", label: "All properties" }] : props.map((x) => ({ value: x.id, label: x.name }))
            }
          />
        </Labeled>
      </div>
      {error && (
        <div role="alert" className="text-[13px] text-st-red">
          {error}
        </div>
      )}
    </ActionDialog>
  )
}

/* ---- Groups ------------------------------------------------------------------------------------------------------- */

type Pool = { id: string; name: string; property: string | null; members: { id: string; name: string }[] }

function GroupsTab({ canManage }: { canManage: boolean }) {
  const q = useQuery({ queryKey: ["pools", "all"], queryFn: () => api.get<{ rows: Pool[] }>("/api/pools") })
  const [editing, setEditing] = React.useState<Pool | null>(null)
  if (q.error) return <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
  if (!q.data) return <LoadingRows rows={4} />
  return (
    <>
      <Summary>
        Groups (pools) can be named on a check as Done by: anyone in the group can do it. Only people can be
        accountable.
      </Summary>
      <div className="overflow-hidden rounded-[10px] border border-divider bg-surface">
        {q.data.rows.length === 0 ? (
          <EmptyState title="No groups yet">Groups are made per property, e.g. Keyholders – The Villa.</EmptyState>
        ) : (
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="h-[34px] bg-background px-4 font-medium">Group</th>
                <th className="bg-background px-3 font-medium">Property</th>
                <th className="bg-background px-3 font-medium">Members</th>
                <th className="bg-background px-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((g) => (
                <tr key={g.id} className="border-t border-divider">
                  <td className="px-4 py-3 font-medium">{g.name}</td>
                  <td className="px-3 text-ink2">{g.property ?? "All properties"}</td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap gap-1">
                      {g.members.length === 0 && (
                        <Pill tone="red" dot>
                          No one yet
                        </Pill>
                      )}
                      {g.members.map((m) => (
                        <Pill key={m.id} tone="grey">
                          {m.name}
                        </Pill>
                      ))}
                    </span>
                  </td>
                  <td className="px-3 text-right">
                    {canManage && (
                      <Button variant="outline" size="sm" onClick={() => setEditing(g)}>
                        Change members
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <MembersDialog pool={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function MembersDialog({ pool, onClose }: { pool: Pool; onClose: () => void }) {
  const qc = useQueryClient()
  const people = useQuery({
    queryKey: ["people-options"],
    queryFn: () => api.get<{ rows: PersonRow[] }>("/api/people", { page_size: 100 }),
  })
  const [ids, setIds] = React.useState<string[]>(pool.members.map((m) => m.id))
  const [filter, setFilter] = React.useState("")
  const m = useMutation({
    mutationFn: () => api.put(`/api/pools/${pool.id}/members`, { name: pool.name, member_ids: ids }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pools"] })
      toast(`${pool.name} now has ${plural(ids.length, "person", "people")}.`)
      onClose()
    },
    onError: (e) => toastError(errMsg(e)),
  })
  const rows = (people.data?.rows ?? []).filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={m.isPending}
      title={`Members of ${pool.name}`}
      subtitle="Anyone in the group can do a check the group is named on."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? "Saving…" : "Save members"}
          </Button>
        </>
      }
    >
      <TextInput
        aria-label="Filter people"
        placeholder="Filter people"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="max-h-72 overflow-y-auto rounded-md border border-divider">
        {!people.data && <LoadingRows rows={4} />}
        {rows.map((p) => (
          <label
            key={p.id}
            className="flex cursor-pointer items-center gap-2.5 border-b border-divider px-3 py-2 last:border-0 hover:bg-hover/50"
          >
            <input
              type="checkbox"
              className="size-4 accent-[var(--c-primary)]"
              checked={ids.includes(p.id)}
              onChange={(e) => setIds((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px]">{p.name}</span>
              <span className="block text-xs text-muted-foreground">{p.property}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="m-0 text-xs text-muted-foreground">{plural(ids.length, "person", "people")} chosen</p>
    </ActionDialog>
  )
}

/* ---- Contractors -------------------------------------------------------------------------------------------------- */

type Contractor = {
  id: string
  name: string
  trade: string | null
  accreditation: string | null
  accreditation_expires: string | null
  accreditation_status: "ok" | "expiring" | "expired"
  email: string | null
  portal?: { id: string; name: string; email: string | null; active: boolean }[]
}

function ContractorsTab({ canManage }: { canManage: boolean }) {
  const q = useQuery({ queryKey: ["contractors"], queryFn: () => api.get<{ rows: Contractor[] }>("/api/contractors") })
  const [adding, setAdding] = React.useState(false)
  const [inviting, setInviting] = React.useState<Contractor | null>(null)
  if (q.error) return <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
  if (!q.data) return <LoadingRows rows={4} />
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Summary className="flex-1">
          Contractors can be named as Done by and use the contractor portal. Their accreditation is checked before a
          visit.
        </Summary>
        {canManage && (
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus /> Add contractor
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-[10px] border border-divider bg-surface">
        {q.data.rows.length === 0 ? (
          <EmptyState title="No contractors yet">
            Add the companies that service alarms, gas, water and the rest.
          </EmptyState>
        ) : (
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                {["Contractor", "Trade", "Accreditation", "Email", "Portal access"].map((h) => (
                  <th key={h} className="h-[34px] bg-background px-4 font-medium">
                    {h}
                  </th>
                ))}
                {canManage && (
                  <th className="h-[34px] bg-background px-4">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((c) => (
                <tr key={c.id} className="border-t border-divider">
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 text-ink2">{c.trade ?? "—"}</td>
                  <td className="px-4">
                    {c.accreditation ? (
                      <span className="flex flex-wrap items-center gap-2">
                        {c.accreditation}
                        {c.accreditation_expires && (
                          <Pill
                            tone={
                              c.accreditation_status === "expired"
                                ? "red"
                                : c.accreditation_status === "expiring"
                                  ? "amber"
                                  : "green"
                            }
                          >
                            {c.accreditation_status === "expired" ? "Expired" : "Expires"}{" "}
                            {fmtDate(c.accreditation_expires)}
                          </Pill>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not recorded</span>
                    )}
                  </td>
                  <td className="px-4 text-ink2">{c.email ?? "—"}</td>
                  <td className="px-4 py-2">
                    {c.portal && c.portal.length > 0 ? (
                      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                        {c.portal.map((x) => (
                          <li key={x.id} className="text-[13px]">
                            {x.name}
                            <span className="text-muted-foreground"> · {x.email}</span>
                            {!x.active && <span className="text-muted-foreground"> (access ended)</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-muted-foreground">No one yet</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-4 text-right whitespace-nowrap">
                      <Button variant="outline" size="sm" onClick={() => setInviting(c)}>
                        Send portal link
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <ContractorDialog onClose={() => setAdding(false)} />}
      {inviting && <PortalInviteDialog contractor={inviting} onClose={() => setInviting(null)} />}
    </>
  )
}

/* The contractor portal: the staff app, signed in with a 7-day email link, showing only this contractor's visits. */
function PortalInviteDialog({ contractor: c, onClose }: { contractor: Contractor; onClose: () => void }) {
  const qc = useQueryClient()
  const [email, setEmail] = React.useState(c.portal?.[0]?.email ?? c.email ?? "")
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const m = useMutation({
    mutationFn: () =>
      api.post("/api/contractor-portal/invite", {
        contractor_id: c.id,
        email: email.trim(),
        name: name.trim() || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contractors"] })
      toast(`Sent ${c.name} a portal link at ${email.trim()}. It works for 7 days.`)
      onClose()
    },
    onError: (e) => setError(errMsg(e)),
  })
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={m.isPending}
      title="Send portal link"
      subtitle={`${c.name} can see their own visits and send reports and fix photos. Nothing counts until a site manager checks it.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? "Sending…" : "Send portal link"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) m.mutate()
        }}
      >
        <Labeled label="Contact's email" htmlFor="pi-email" error={error}>
          <TextInput
            id="pi-email"
            type="email"
            autoFocus
            value={email}
            aria-invalid={!!error || undefined}
            onChange={(e) => {
              setEmail(e.target.value)
              setError(null)
            }}
          />
        </Labeled>
        <Labeled label="Contact's name (optional)" htmlFor="pi-name">
          <TextInput id="pi-name" value={name} placeholder={c.name} onChange={(e) => setName(e.target.value)} />
        </Labeled>
      </form>
    </ActionDialog>
  )
}

function ContractorDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = React.useState({ name: "", trade: "", accreditation: "", accreditation_expires: "", email: "" })
  const [error, setError] = React.useState<string | null>(null)
  const m = useMutation({
    mutationFn: () =>
      api.post("/api/contractors", {
        name: v.name.trim(),
        trade: v.trade || null,
        accreditation: v.accreditation || null,
        accreditation_expires: v.accreditation_expires || null,
        email: v.email || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contractors"] })
      toast(`Added ${v.name.trim()}.`)
      onClose()
    },
    onError: (e) => setError(errMsg(e)),
  })
  const f = (k: keyof typeof v) => ({
    value: v[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value }),
  })
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={m.isPending}
      title="Add a contractor"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={v.name.trim().length < 2 || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? "Adding…" : "Add contractor"}
          </Button>
        </>
      }
    >
      <Labeled label="Company name" htmlFor="c-name">
        <TextInput id="c-name" autoFocus {...f("name")} />
      </Labeled>
      <Labeled label="Trade" htmlFor="c-trade">
        <TextInput id="c-trade" placeholder="e.g. Fire alarm and emergency lighting" {...f("trade")} />
      </Labeled>
      <div className="grid grid-cols-2 gap-3">
        <Labeled label="Accreditation" htmlFor="c-acc">
          <TextInput id="c-acc" placeholder="e.g. BAFE SP203-1" {...f("accreditation")} />
        </Labeled>
        <Labeled label="Accreditation expires" htmlFor="c-exp">
          <TextInput id="c-exp" type="date" {...f("accreditation_expires")} />
        </Labeled>
      </div>
      <Labeled label="Email for job requests" htmlFor="c-email" error={error}>
        <TextInput id="c-email" type="email" {...f("email")} />
      </Labeled>
    </ActionDialog>
  )
}

/* ---- Dutyholders -------------------------------------------------------------------------------------------------- */

type Dutyholder = {
  id: string
  name: string
  company_number: string | null
  directors: { id: string; name: string }[]
  properties: string[]
}

function DutyholdersTab() {
  const q = useQuery({ queryKey: ["dutyholders"], queryFn: () => api.get<{ rows: Dutyholder[] }>("/api/dutyholders") })
  if (q.error) return <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
  if (!q.data) return <LoadingRows rows={3} />
  return (
    <>
      <Summary>
        The company that owns each property is its dutyholder. Only its directors can sign the FRA and the opening
        checklist.
      </Summary>
      <div className="overflow-hidden rounded-[10px] border border-divider bg-surface">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              {["Dutyholder", "Company number", "Directors who sign", "Properties"].map((h) => (
                <th key={h} className="h-[34px] bg-background px-4 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.data.rows.map((d) => (
              <tr key={d.id} className="border-t border-divider">
                <td className="px-4 py-3 font-medium">{d.name}</td>
                <td className="mono-id px-4 text-ink2">{d.company_number ?? "—"}</td>
                <td className="px-4">
                  <span className="flex flex-wrap gap-1">
                    {d.directors.length === 0 && (
                      <Pill tone="red" dot>
                        No director named
                      </Pill>
                    )}
                    {d.directors.map((x) => (
                      <Pill key={x.id} tone="grey">
                        {x.name}
                      </Pill>
                    ))}
                  </span>
                </td>
                <td className="px-4 text-ink2">{d.properties.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
