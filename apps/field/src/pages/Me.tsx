import { appPath } from "@/lib/base"
/*
 * Me (design: AppMe). This month's numbers, the streak, notification settings and this phone. Signing out clears
 * everything the app kept on the phone (IndexedDB and caches), as §9 requires.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@bide-comply/api-client"
import { Check } from "lucide-react"
import * as React from "react"

import { Card, SectionLabel, TabBar, Toggle } from "@/components/kit"
import { Sheet } from "@/components/Sheet"
import { OfflineBanner } from "@/components/sync"
import { cachedGet, clearCache } from "@/lib/cache"
import { fmtDate } from "@/lib/format"
import { clearQueue, useQueue } from "@/lib/queue"
import { useMe } from "@/lib/session"
import type { FieldMe } from "@/lib/types"

export async function wipePhone(): Promise<void> {
  await Promise.allSettled([clearCache(), clearQueue()])
  try {
    const dbs = (await indexedDB.databases?.()) ?? []
    await Promise.allSettled(
      dbs.map(
        (d) =>
          new Promise<void>((resolve) => {
            if (!d.name) return resolve()
            const r = indexedDB.deleteDatabase(d.name)
            r.onsuccess = r.onerror = r.onblocked = () => resolve()
          }),
      ),
    )
  } catch {
    /* older browsers: the stores above are already empty */
  }
  if ("caches" in window) {
    const keys = await caches.keys().catch(() => [] as string[])
    await Promise.allSettled(keys.map((k) => caches.delete(k)))
  }
  try {
    localStorage.removeItem("bc-field-property")
  } catch {
    /* private mode */
  }
}

export function MePage() {
  const me = useMe()
  const qc = useQueryClient()
  const queue = useQueue()
  const fm = useQuery({ queryKey: ["field-me"], queryFn: () => cachedGet<FieldMe>("/api/field/me") })
  const [prefs, setPrefs] = React.useState<Record<string, unknown>>({})
  const [confirm, setConfirm] = React.useState(false)
  const [leaving, setLeaving] = React.useState(false)
  const all = { push: true, reminder: true, quiet_days_off: false, ...(fm.data?.preferences ?? {}), ...prefs }

  const setPref = (k: string, v: boolean) => {
    setPrefs((p) => ({ ...p, [k]: v }))
    if (k === "push" && v && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission()
    }
    void api.post("/api/me/preferences", { [k]: v }).then(
      () => qc.invalidateQueries({ queryKey: ["field-me"] }),
      () => setPrefs((p) => ({ ...p, [k]: !v })),
    )
  }

  const signOut = async () => {
    setLeaving(true)
    await api.post("/api/auth/logout").catch(() => undefined)
    await wipePhone()
    qc.clear()
    window.location.href = appPath("/signin")
  }

  const m = fm.data?.month
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col bg-background">
      <OfflineBanner />
      <header className="flex items-center gap-3.5 border-b border-divider bg-surface px-[18px] pt-5 pb-4">
        <span
          aria-hidden
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-st-blue-bg text-[16px] font-semibold text-st-blue"
        >
          {me.data?.initials}
        </span>
        <div className="min-w-0">
          <h1 className="m-0 text-[20px] leading-tight font-semibold">{me.data?.name}</h1>
          <p className="m-0 mt-0.5 text-[14.5px] text-muted-foreground">{fm.data?.title ?? me.data?.title}</p>
        </div>
      </header>
      <main className="flex flex-1 flex-col gap-2.5 px-4 pt-3 pb-6">
        <SectionLabel>This month</SectionLabel>
        <div className="grid grid-cols-3 gap-2">
          <Stat value={m ? (m.on_time == null ? "–" : `${m.on_time}%`) : "…"} label="On time" />
          <Stat value={m ? String(m.done) : "…"} label="Checks done" />
          <Stat value={m ? String(m.problems) : "…"} label="Problems found" />
        </div>
        {fm.data && (
          <Card className="flex items-start gap-3 px-4 py-3.5 text-[15px]">
            <Check aria-hidden className="mt-0.5 size-5 shrink-0 text-st-green" />
            <span>
              {fm.data.streak_days > 0 ? (
                <>
                  <strong>
                    {fm.data.streak_days} day{fm.data.streak_days === 1 ? "" : "s"} in a row
                  </strong>{" "}
                  with every check on time.
                </>
              ) : (
                "Do today's checks on time to start a streak."
              )}{" "}
              Finding problems never costs you points.
            </span>
          </Card>
        )}

        <SectionLabel>Notifications</SectionLabel>
        <Card className="divide-y divide-divider">
          <Toggle label="Phone notifications" checked={Boolean(all.push)} onChange={(v) => setPref("push", v)} />
          <Toggle
            label="Reminder before a check is due"
            hint="1 hour before"
            checked={Boolean(all.reminder)}
            onChange={(v) => setPref("reminder", v)}
          />
          <Toggle
            label="Quiet on days off"
            checked={Boolean(all.quiet_days_off)}
            onChange={(v) => setPref("quiet_days_off", v)}
          />
        </Card>
        <p className="m-0 px-1 text-[13.5px] text-muted-foreground">Life-safety alerts always come through.</p>

        <SectionLabel>This phone</SectionLabel>
        <Card className="divide-y divide-divider">
          <div className="flex min-h-[60px] items-center gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[15.5px]">Waiting to send</div>
              <div className="text-[13.5px] text-muted-foreground">Sends when you're back online</div>
            </div>
            <span className="tabular rounded-full bg-hover px-2.5 py-0.5 text-[14px] font-semibold">
              {queue.length}
            </span>
          </div>
          <div className="flex min-h-[60px] items-center gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[15.5px]">Trusted until</div>
              <div className="text-[13.5px] text-muted-foreground">Then you'll get a new email code</div>
            </div>
            <span className="text-[15px] text-ink2">
              {fm.data?.trusted_until ? fmtDate(fm.data.trusted_until) : "–"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => (queue.length ? setConfirm(true) : void signOut())}
            disabled={leaving}
            className="flex min-h-[56px] w-full items-center px-3.5 text-left text-[16px] font-medium text-st-red"
          >
            {leaving ? "Signing out" : "Sign out"}
          </button>
        </Card>
      </main>
      <TabBar />
      <Sheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Sign out with checks not sent?"
        description={`${queue.length} check${queue.length === 1 ? " hasn't" : "s haven't"} been sent yet. Signing out deletes ${queue.length === 1 ? "it" : "them"} from this phone, and you'd need to do ${queue.length === 1 ? "it" : "them"} again.`}
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              className="h-12 flex-[1.4] rounded-xl bg-primary text-[16px] font-semibold text-primary-foreground"
            >
              Stay signed in
            </button>
            <button
              type="button"
              onClick={() => void signOut()}
              className="h-12 flex-1 rounded-xl border border-st-red text-[16px] font-semibold text-st-red"
            >
              Sign out
            </button>
          </>
        }
      />
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-divider bg-surface px-3.5 py-3.5">
      <div className="tabular text-[26px] leading-none font-semibold">{value}</div>
      <div className="mt-2 text-[13.5px] leading-tight text-muted-foreground">{label}</div>
    </div>
  )
}
