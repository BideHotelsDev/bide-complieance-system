/*
 * Home on a phone (design: Manager on phone): what needs you, then life-safety checks late by property. Full
 * dashboards stay on the desktop.
 */
import { useQuery } from "@tanstack/react-query"
import { useRouterState } from "@tanstack/react-router"
import { House, ListChecks, Flag, User } from "lucide-react"

import { api, ApiError } from "@bide-comply/api-client"
import { EmptyState, ErrorState, Skeleton } from "@bide-comply/ui/components/page"
import { Pill, type Tone } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import { fmtDate } from "@/lib/format"
import { useMe } from "@/lib/session"

import { AppLink, hello, type MobileHome, type PropertySummary, type TodoItem } from "./home-shared"

type Row = { key: string; word: string; tone: Tone; text: string; href: string }

function needRow(i: TodoItem, today: string): Row {
  if (i.kind === "call") return { key: i.id, word: "Overdue", tone: "red", text: i.title, href: i.link }
  if (i.kind === "approval") return { key: i.id, word: "Decide", tone: "blue", text: i.title, href: i.link }
  const late = i.due_on != null && i.due_on < today
  return {
    key: i.id,
    word: late ? "Overdue" : i.due_on ? `Due ${fmtDate(i.due_on)}` : "Do",
    tone: late ? "red" : "amber",
    text: i.title,
    href: i.link,
  }
}

function Tile({ p }: { p: PropertySummary }) {
  const opening = p.stage === "pre_opening"
  const big = p.register_loaded
    ? String(p.class_a_late)
    : opening && p.gate
      ? `${p.gate.done}/${p.gate.applicable}`
      : "–"
  const muted = !p.register_loaded
  const sub = p.register_loaded
    ? `score ${p.score ?? 0}%`
    : opening
      ? `checklist · opens ${p.opening_date ? new Date(`${p.opening_date}T12:00:00Z`).toLocaleDateString("en-GB", { month: "short" }) : "soon"}`
      : "register not loaded"
  return (
    <AppLink
      href={opening ? `/gates/${p.code}` : `/properties/${p.code}`}
      className="flex flex-col gap-0.5 rounded-[14px] border border-divider bg-surface p-3 text-foreground no-underline"
    >
      <span className="text-[14px] font-semibold">{p.name}</span>
      <span className={cn("tabular text-[28px] leading-[1.15] font-semibold", muted && "text-subtle")}>{big}</span>
      <span className="text-[12.5px] text-muted-foreground">{sub}</span>
      <span className="mt-1.5">
        <Pill tone={p.score_status === "grey" ? "grey" : p.score_status}>{opening ? "Not ready" : p.status_label}</Pill>
      </span>
    </AppLink>
  )
}

export function MobileHomeView({ today }: { today: string }) {
  const q = useQuery<MobileHome, ApiError>({
    queryKey: ["mobile-home"],
    queryFn: () => api.get<MobileHome>("/api/mobile-home"),
  })
  const me = useMe()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const rows: Row[] = q.data
    ? [
        ...q.data.needs.map((n) => needRow(n, today)),
        ...(q.data.signatures ?? []).map((s) => ({
          key: s.id,
          word: "Sign",
          tone: "amber" as Tone,
          text: `${s.title} · ${s.property}`,
          href: `/signoffs?sel=${s.id}`,
        })),
      ]
    : []
  const tabs = [
    { href: "/", label: "Home", icon: House },
    { href: "/todo", label: "To-do", icon: ListChecks },
    { href: "/actions", label: "Actions", icon: Flag },
    { href: "/me", label: "Me", icon: User },
  ]
  return (
    <div className="-mx-4 -my-5 flex min-h-[calc(100vh)] flex-col pb-20">
      <header className="border-b border-divider bg-surface px-[18px] pt-[18px] pb-3">
        <div className="text-[14px] text-muted-foreground">{hello(me.data?.name, me.data?.first_name)}</div>
        <h1 className="m-0 text-[22px] font-semibold">
          {q.data
            ? rows.length
              ? `${rows.length} ${rows.length === 1 ? "thing needs" : "things need"} you`
              : "Nothing needs you"
            : " "}
        </h1>
      </header>
      <div className="flex flex-1 flex-col gap-3 p-4">
        {q.isPending ? (
          <>
            <Skeleton className="h-48 rounded-[14px]" />
            <Skeleton className="h-40 rounded-[14px]" />
          </>
        ) : q.isError ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : (
          <>
            <div className="overflow-hidden rounded-[14px] border border-divider bg-surface">
              {rows.length === 0 ? (
                <EmptyState title="You're up to date">Nothing is waiting for you right now.</EmptyState>
              ) : (
                rows.map((r, i) => (
                  <AppLink
                    key={r.key}
                    href={r.href}
                    className={cn(
                      "flex min-h-12 items-center gap-3 p-3.5 text-foreground no-underline",
                      i < rows.length - 1 && "border-b border-divider",
                    )}
                  >
                    <Pill tone={r.tone} className="shrink-0">
                      {r.word}
                    </Pill>
                    <span className="line-clamp-2 flex-1 text-[14px]">{r.text}</span>
                  </AppLink>
                ))
              )}
            </div>
            <h2 className="m-0 text-[13px] font-semibold text-muted-foreground">Life-safety checks late</h2>
            <div className="grid grid-cols-2 gap-2.5">
              {q.data.properties.map((p) => (
                <Tile key={p.id} p={p} />
              ))}
            </div>
            <p className="m-0 text-center text-[13px] text-muted-foreground">
              Full dashboards and reports are on the desktop.
            </p>
          </>
        )}
      </div>
      <nav aria-label="App" className="fixed inset-x-0 bottom-0 z-30 flex h-16 border-t border-divider bg-surface">
        {tabs.map((t) => {
          const on = t.href === "/" ? path === "/" : path.startsWith(t.href)
          return (
            <AppLink
              key={t.href}
              href={t.href}
              aria-current={on ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 pt-2 text-[11px] no-underline",
                on ? "font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              <t.icon aria-hidden className="size-[22px]" />
              {t.label}
            </AppLink>
          )
        })}
      </nav>
    </div>
  )
}
