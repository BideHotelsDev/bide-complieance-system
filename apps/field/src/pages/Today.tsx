/*
 * Today (design: AppToday, EXE-01). Overdue pinned at the top, then today's checks, then what's coming up. The list is
 * kept on the phone so it opens with no signal, and each open check's form is fetched ahead for the same reason.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Pill } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"
import { ChartNoAxesColumn, ChevronDown, ChevronRight, ClipboardList, TriangleAlert } from "lucide-react"
import * as React from "react"

import { InstallHint } from "@/components/InstallHint"
import { ErrorBox, Loading, SectionLabel, TabScreen } from "@/components/kit"
import { PropertyPicker } from "@/components/PropertyPicker"
import { SyncPill, WaitingList } from "@/components/sync"
import { cachedGet } from "@/lib/cache"
import { useQueue } from "@/lib/queue"
import { useMe, useProperty } from "@/lib/session"
import type { TaskCard, TaskDetail, Today } from "@/lib/types"

function greeting(): string {
  const h = Number(new Date().toLocaleString("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" }))
  return h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening"
}

export function TodayPage() {
  const me = useMe()
  const { propertyId } = useProperty()
  const multi = (me.data?.properties.length ?? 0) > 1
  const qc = useQueryClient()
  const queue = useQueue()
  const [picking, setPicking] = React.useState(false)
  const today = useQuery({
    queryKey: ["today", multi ? propertyId : null],
    queryFn: () => cachedGet<Today>("/api/field/today", { property: multi ? propertyId : undefined }),
  })

  // Fetch each open check ahead, so it can be done offline.
  React.useEffect(() => {
    if (!today.data) return
    for (const c of [...today.data.overdue, ...today.data.today]) {
      void qc.prefetchQuery({
        queryKey: ["task", c.task_id],
        queryFn: () => cachedGet<TaskDetail>(`/api/field/tasks/${c.task_id}`),
        staleTime: 60_000,
      })
    }
  }, [today.data, qc])

  const queued = new Set(queue.map((q) => q.task_id))
  const d = today.data
  const overdue = d?.overdue.filter((c) => !queued.has(c.task_id)) ?? []
  const todays = d?.today.filter((c) => !queued.has(c.task_id)) ?? []
  const toDo = overdue.length + todays.length
  const propName = me.data?.properties.find((p) => p.id === propertyId)?.name ?? d?.properties[0]?.name ?? ""

  return (
    <TabScreen
      header={
        <>
          <div className="flex items-center justify-between gap-2">
            {multi ? (
              <button
                type="button"
                aria-label={`Switch property. Now: ${propName}`}
                onClick={() => setPicking(true)}
                className="flex h-11 items-center gap-1.5 rounded-full border border-border bg-surface px-4 text-[15px] font-semibold"
              >
                {propName}
                <ChevronDown aria-hidden className="size-4" />
              </button>
            ) : (
              <span className="flex h-11 items-center rounded-full border border-border bg-surface px-4 text-[15px] font-semibold">
                {propName}
              </span>
            )}
            <SyncPill />
          </div>
          <h1 className="m-0 mt-3.5 text-[24px] leading-tight font-semibold">
            {greeting()}, {d?.first_name ?? me.data?.first_name}
          </h1>
          <p className="m-0 mt-1 text-[15px] text-muted-foreground">
            {d ? `${d.date_label} · ${toDo} to do today` : " "}
          </p>
        </>
      }
    >
      <WaitingList />
      {today.isPending ? (
        <Loading label="Loading today's checks" />
      ) : today.error ? (
        <ErrorBox message={today.error.message} onRetry={() => void today.refetch()} />
      ) : (
        <>
          {overdue.length > 0 && (
            <>
              <SectionLabel className="text-st-red">Overdue · {overdue.length}</SectionLabel>
              {overdue.map((c) => (
                <TaskLink key={c.task_id} card={c} overdue />
              ))}
            </>
          )}
          <SectionLabel>Today · {todays.length}</SectionLabel>
          {todays.length ? (
            todays.map((c) => <TaskLink key={c.task_id} card={c} />)
          ) : (
            <p className="m-0 rounded-xl border border-divider bg-surface px-4 py-4 text-[15px] text-muted-foreground">
              {overdue.length ? "Nothing else due today." : (d!.nothing_overdue ?? "Nothing due today. Thank you.")}
            </p>
          )}
          {d!.upcoming.length > 0 && (
            <>
              <SectionLabel>Coming up</SectionLabel>
              {d!.upcoming.map((c) => (
                <div key={c.task_id} className="rounded-xl border border-divider bg-surface px-3.5 py-3">
                  <div className="text-[16px] font-semibold">{c.title}</div>
                  <div className="text-[14px] text-muted-foreground">{c.badge}</div>
                </div>
              ))}
            </>
          )}
          <div className="mt-1 flex items-center gap-3 rounded-xl bg-hover px-4 py-3.5 text-[15px]">
            <ChartNoAxesColumn aria-hidden className="size-5 shrink-0" />
            {d!.streak_weeks > 0 ? (
              <span>
                <strong>
                  {d!.streak_weeks} week{d!.streak_weeks === 1 ? "" : "s"}
                </strong>{" "}
                of every check on time
              </span>
            ) : (
              <span>Every check on time this week starts a streak.</span>
            )}
          </div>
        </>
      )}
      <Link
        to="/report"
        className="mt-1 flex h-[52px] items-center justify-center gap-2 rounded-xl border border-border bg-surface text-[16px] font-semibold text-foreground no-underline"
      >
        <TriangleAlert aria-hidden className="size-5" />
        Report an issue or incident
      </Link>
      {me.data?.can["task.complete"] && (
        <Link
          to="/contractor-visit"
          className="flex min-h-12 items-center justify-center gap-2 text-[15px] font-medium text-link no-underline"
        >
          <ClipboardList aria-hidden className="size-4" />
          Log a contractor visit
        </Link>
      )}
      <InstallHint />
      {picking && <PropertyPicker onClose={() => setPicking(false)} />}
    </TabScreen>
  )
}

function TaskLink({ card, overdue }: { card: TaskCard; overdue?: boolean }) {
  const dueToday = card.badge === "Due today"
  return (
    <Link
      to="/task/$taskId"
      params={{ taskId: card.task_id }}
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-surface py-3 pr-3 pl-3.5 text-foreground no-underline hover:bg-hover",
        overdue ? "border-st-red/40 border-l-[3px] border-l-st-red" : "border-divider",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {card.life_safety && <Pill tone="red">Life safety</Pill>}
          <span className="text-[16.5px] leading-snug font-semibold">{card.title}</span>
        </div>
        <div className="mt-1 text-[14px] text-muted-foreground">{card.subtitle}</div>
        {(overdue || !dueToday || card.na_pending) && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {overdue ? <Pill tone="red">{card.badge}</Pill> : !dueToday && <Pill tone="grey">{card.badge}</Pill>}
            {card.na_pending && <Pill tone="grey">Asked to mark not applicable</Pill>}
          </div>
        )}
      </div>
      <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground" />
    </Link>
  )
}
