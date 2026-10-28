/*
 * Your account: who you are and what you can do, how you're told about things (Class A alerts can't be muted, §7),
 * how the screen looks, your in-app notifications, and sign out.
 */
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bell, LogOut } from "lucide-react"
import * as React from "react"

import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Segmented } from "@bide-comply/ui/components/filter-bar"
import { Avatar, Card, Dl, EmptyState, ErrorState, LoadingPage, LoadingRows, PageHeader } from "@bide-comply/ui/components/page"
import { Pill } from "@bide-comply/ui/components/status"
import { Switch } from "@bide-comply/ui/components/switch"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { applyMode, savedMode, type Mode } from "@bide-comply/ui/lib/theme"
import { cn } from "@bide-comply/ui/lib/utils"

import { fmtDateTime, fmtTime, relative } from "@/lib/format"
import { useMe, type Me } from "@/lib/session"

type Notification = {
  id: string
  kind: string
  class: string | null
  title: string
  body: string | null
  link: string | null
  read: boolean
  created_at: string
}
type Channel = "slack" | "email"
type Density = "comfortable" | "compact"

const ROLE: Record<string, string> = {
  super_admin: "Super Admin",
  system_owner: "System owner",
  dutyholder: "SPV dutyholder",
  site_lead: "Site lead",
  register_keeper: "Register keeper",
  keyholder: "Keyholder",
  staff: "Staff",
  systems: "Systems",
  assessor: "Competent assessor",
  contractor: "Contractor",
}

export function MePage() {
  const me = useMe()
  if (me.isPending) return <LoadingPage />
  if (me.error) return <ErrorState message={me.error.message} onRetry={() => void me.refetch()} />
  return (
    <div className="flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Your account" subtitle="Notifications, display and sign out." actions={<SignOut />} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <About me={me.data} />
        <Preferences me={me.data} />
      </div>
      <Notifications />
    </div>
  )
}

function SignOut() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const out = useMutation({
    mutationFn: () => api.post("/api/auth/logout"),
    onSettled: () => {
      // Whatever the server said, forget everything cached in this tab and go to sign-in.
      qc.clear()
      void navigate({ to: "/signin" })
    },
  })
  return (
    <Button variant="outline" onClick={() => out.mutate()} disabled={out.isPending}>
      <LogOut aria-hidden />
      Sign out
    </Button>
  )
}

function About({ me }: { me: Me }) {
  const roles = Array.from(new Set(me.roles.map((r) => ROLE[r] ?? r.replace(/_/g, " "))))
  return (
    <Card title="You" bodyClassName="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <Avatar initials={me.initials} className="size-11 text-[14px]" />
        <div className="min-w-0">
          <div className="truncate text-[16px] font-semibold">{me.name}</div>
          <div className="truncate text-[13px] text-muted-foreground">{me.title}</div>
        </div>
      </div>
      <Dl
        items={[
          { label: "Email", value: me.email ?? <span className="text-muted-foreground">None on file</span> },
          {
            label: "Roles",
            value: (
              <span className="flex flex-wrap gap-1.5">
                {roles.map((r) => (
                  <Pill key={r} tone="grey">
                    {r}
                  </Pill>
                ))}
              </span>
            ),
          },
          {
            label: "Properties",
            value: me.all_properties ? "All properties" : me.properties.map((p) => p.name).join(", ") || "None yet",
          },
          ...(me.session_ends_hours
            ? [{ label: "Session", value: `Signs you out after ${me.session_ends_hours} hours, as you're signed in by email link.` }]
            : []),
        ]}
      />
      <p className="m-0 text-[12.5px] text-muted-foreground">
        Something wrong here? Ask Samantha (system owner) to change your roles or properties.
      </p>
    </Card>
  )
}

function Preferences({ me }: { me: Me }) {
  const qc = useQueryClient()
  const prefs = me.preferences as { muted?: string[]; density?: Density; theme?: Mode }
  const [muted, setMuted] = React.useState<string[]>(prefs.muted ?? [])
  const [density, setDensity] = React.useState<Density>(prefs.density ?? "comfortable")
  const [mode, setMode] = React.useState<Mode>(() => savedMode())
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post("/api/me/preferences", body),
    onSuccess: () => {
      toast("Saved.")
      void qc.invalidateQueries({ queryKey: ["me"] })
    },
    onError: (e: ApiError) => toastError(e.message),
  })

  const setChannel = (c: Channel, on: boolean) => {
    const next = on ? muted.filter((m) => m !== c) : Array.from(new Set([...muted, c]))
    setMuted(next)
    save.mutate({ muted: next })
  }
  const channels: { key: Channel; label: string; line: string }[] = [
    { key: "slack", label: "Slack", line: "Direct messages from the bide Comply app" },
    { key: "email", label: "Email", line: me.email ? `To ${me.email}` : "No email address on file" },
  ]

  return (
    <div className="flex flex-col gap-4">
      <Card title="How you're told">
        <ul className="m-0 list-none p-0">
          <li className="flex items-center gap-3 border-b border-divider px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">In the app</span>
              <span className="block text-[13px] text-muted-foreground">Always on. Shown below and on your Home page.</span>
            </span>
            <Pill tone="green">On</Pill>
          </li>
          {channels.map((c) => {
            const on = !muted.includes(c.key)
            const id = `ch-${c.key}`
            return (
              <li key={c.key} className="flex items-center gap-3 border-b border-divider px-4 py-3">
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                  <span className="block font-medium">{c.label}</span>
                  <span className="block text-[13px] text-muted-foreground">{c.line}</span>
                </label>
                <span className={cn("text-[13px]", on ? "text-st-green" : "text-muted-foreground")}>{on ? "On" : "Muted"}</span>
                <Switch id={id} checked={on} onCheckedChange={(v) => setChannel(c.key, v)} disabled={save.isPending} />
              </li>
            )
          })}
        </ul>
        <p className="m-0 px-4 py-3 text-[12.5px] text-muted-foreground">
          Class A (life-safety) alerts can't be muted. They always reach you on every channel, whatever you choose here.
        </p>
      </Card>

      <Card title="Display" bodyClassName="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-[110px] font-medium">Appearance</span>
          <Segmented<Mode>
            label="Appearance"
            value={mode}
            onChange={(m) => {
              setMode(m)
              applyMode(m)
              save.mutate({ theme: m })
            }}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "Match device" },
              { value: "contrast", label: "High contrast" },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-[110px] font-medium">Density</span>
          <Segmented<Density>
            label="Density"
            value={density}
            onChange={(d) => {
              setDensity(d)
              save.mutate({ density: d })
            }}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </div>
        <p className="m-0 text-[12.5px] text-muted-foreground">
          Appearance applies on this device straight away. The colours and logo for everyone are set in Settings › Appearance.
        </p>
      </Card>
    </div>
  )
}

function Notifications() {
  const qc = useQueryClient()
  const q = useQuery<{ rows: Notification[]; unread: number }, ApiError>({
    queryKey: ["notifications"],
    queryFn: () => api.get("/api/notifications"),
  })
  const read = useMutation({
    mutationFn: () => api.post("/api/notifications/read"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notifications"] })
      toast("All marked as read.")
    },
    onError: (e: ApiError) => toastError(e.message),
  })
  const unread = q.data?.unread ?? 0
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Notifications
          {unread > 0 && <Pill tone="blue">{unread} unread</Pill>}
        </span>
      }
      action={
        unread > 0 && (
          <Button size="sm" variant="outline" onClick={() => read.mutate()} disabled={read.isPending}>
            Mark all as read
          </Button>
        )
      }
    >
      {q.isPending ? (
        <LoadingRows rows={4} label="Loading notifications" />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.data.rows.length === 0 ? (
        <EmptyState icon={<Bell className="size-6" aria-hidden />} title="No notifications">
          Reminders, alerts and replies to you appear here.
        </EmptyState>
      ) : (
        <ul className="m-0 list-none p-0">
          {q.data.rows.map((n) => (
            <li key={n.id} className={cn("flex gap-3 border-b border-divider px-4 py-3 last:border-b-0", !n.read && "bg-st-blue-bg/30")}>
              <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-st-blue")} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  {n.link?.startsWith("/") ? (
                    <Link to={n.link.split("?")[0]} search={Object.fromEntries(new URLSearchParams(n.link.split("?")[1] ?? ""))} className="font-medium text-foreground no-underline hover:underline">
                      {n.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{n.title}</span>
                  )}
                  {n.class === "A" && <Pill tone="red">Life safety</Pill>}
                  {!n.read && <span className="sr-only">(unread)</span>}
                </span>
                {n.body && <span className="mt-0.5 block text-[13px] text-muted-foreground">{n.body}</span>}
              </span>
              <time dateTime={n.created_at} title={fmtDateTime(n.created_at)} className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
                {relative(n.created_at) === "today" ? fmtTime(n.created_at) : relative(n.created_at)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
