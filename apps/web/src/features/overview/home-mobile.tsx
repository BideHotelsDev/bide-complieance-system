/*
 * Home on a phone (design: Manager on phone): what needs you, each with a verb (Overdue, Sign, Decide) and the
 * property, then life-safety checks late by property. Full dashboards stay on the desktop. The bottom app bar and
 * the menu sheet come from the shell (components/PhoneNav).
 */
import { useQuery } from "@tanstack/react-query"

import { api, ApiError } from "@bide-comply/api-client"
import { EmptyState, ErrorState, Skeleton } from "@bide-comply/ui/components/page"
import { Pill, type Tone } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import { PhoneMenuButton } from "@/components/PhoneNav"
import { fmtDate } from "@/lib/format"
import { useMe } from "@/lib/session"

import { AppLink, hello, type MobileHome, type PropertySummary, type TodoItem } from "./home-shared"

type Row = { key: string; word: string; tone: Tone; text: string; href: string; rank: number }

/* "Fire risk assessment · The Villa": add the property unless the title already names it. */
function withProperty(title: string, property: string | null | undefined): string {
  return property && !title.includes(property) ? `${title} · ${property}` : title
}

/* The chip already says "Sign": "Sign the Fire Risk Assessment" reads as "Fire Risk Assessment". */
function unSign(title: string): string {
  const t = title.replace(/^sign (the )?/i, "")
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function needRow(i: TodoItem, today: string): Row {
  const text = withProperty(i.title, i.property)
  if (i.kind === "call") return { key: i.id, word: "Overdue", tone: "red", text, href: i.link, rank: 0 }
  if (i.kind === "approval") return { key: i.id, word: "Decide", tone: "blue", text, href: i.link, rank: 2 }
  const late = i.due_on != null && i.due_on < today
  if (late) return { key: i.id, word: "Overdue", tone: "red", text, href: i.link, rank: 0 }
  return {
    key: i.id,
    word: i.due_on ? (i.due_on === today ? "Due today" : `Due ${fmtDate(i.due_on)}`) : "Fix",
    tone: i.due_on === today ? "amber" : "grey",
    text,
    href: i.link,
    rank: 3,
  }
}

function opensMonth(d: string | null): string {
  return d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }) : "soon"
}

function Tile({ p }: { p: PropertySummary }) {
  const opening = p.stage === "pre_opening"
  const big = p.register_loaded
    ? String(p.class_a_late)
    : opening && p.gate
      ? `${p.gate.done}/${p.gate.applicable}`
      : "–"
  const sub = p.register_loaded
    ? p.score == null
      ? "no score yet"
      : `score ${p.score}%`
    : opening
      ? `checklist · opens ${opensMonth(p.opening_date)}`
      : "register not loaded"
  return (
    <AppLink
      href={opening ? `/gates/${p.code}` : `/properties/${p.code}`}
      aria-label={`${p.name}: ${p.register_loaded ? `${big} life-safety ${p.class_a_late === 1 ? "check" : "checks"} late, ${sub}` : sub}, ${opening ? "not ready" : p.status_label}`}
      className="flex min-w-0 flex-col gap-0.5 rounded-[14px] border border-divider bg-surface p-3 text-foreground no-underline hover:bg-hover/40"
    >
      <span className="truncate text-[14px] font-semibold">{p.name}</span>
      <span className={cn("tabular text-[28px] leading-[1.15] font-semibold", !p.register_loaded && "text-subtle")}>
        {big}
      </span>
      <span className="text-[12.5px] text-muted-foreground">{sub}</span>
      <span className="mt-1.5">
        {opening ? <Pill tone="grey">Not ready</Pill> : <Pill tone={p.score_status}>{p.status_label}</Pill>}
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
  const rows: Row[] = q.data
    ? [
        ...q.data.needs.map((n) => needRow(n, today)),
        ...(q.data.signatures ?? []).map((s) => ({
          key: s.id,
          word: "Sign",
          tone: "amber" as Tone,
          text: withProperty(unSign(s.title), s.property),
          href: `/signoffs?sel=${s.id}`,
          rank: 1,
        })),
      ].sort((a, b) => a.rank - b.rank)
    : []
  const total = Math.max(q.data?.total ?? 0, rows.length)
  return (
    <div className="-mx-4 -mt-5 flex flex-col">
      <header className="flex items-start gap-2 border-b border-divider bg-surface pt-[18px] pr-2 pb-3 pl-[18px]">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] text-muted-foreground">{hello(me.data?.name, me.data?.first_name)}</div>
          <h1 className="m-0 text-[22px] font-semibold">
            {q.data
              ? total
                ? `${total} ${total === 1 ? "thing needs" : "things need"} you`
                : "Nothing needs you"
              : " "}
          </h1>
        </div>
        <PhoneMenuButton className="-mt-1.5" />
      </header>
      <div className="flex flex-col gap-3 p-4">
        {q.isPending ? (
          <>
            <Skeleton className="h-48 rounded-[14px]" />
            <Skeleton className="h-40 rounded-[14px]" />
          </>
        ) : q.isError ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : (
          <>
            <section aria-label="Needs you" className="overflow-hidden rounded-[14px] border border-divider bg-surface">
              {rows.length === 0 ? (
                <EmptyState title="You're up to date">Nothing is waiting for you right now.</EmptyState>
              ) : (
                <ul className="m-0 list-none p-0">
                  {rows.map((r) => (
                    <li key={r.key} className="border-b border-divider last:border-b-0">
                      <AppLink
                        href={r.href}
                        className="flex min-h-12 items-center gap-3 p-3.5 text-foreground no-underline hover:bg-hover/40"
                      >
                        <Pill tone={r.tone} className="shrink-0">
                          {r.word}
                        </Pill>
                        <span className="line-clamp-2 flex-1 text-[14px]">{r.text}</span>
                      </AppLink>
                    </li>
                  ))}
                  {total > rows.length && (
                    <li>
                      <AppLink
                        href="/todo"
                        className="flex min-h-12 items-center justify-center p-3.5 text-[14px] font-medium text-link no-underline"
                      >
                        See all {total} in To-do
                      </AppLink>
                    </li>
                  )}
                </ul>
              )}
            </section>
            {q.data.properties.length > 0 && (
              <>
                <h2 className="m-0 text-[13px] font-semibold text-muted-foreground">Life-safety checks late</h2>
                <div className="grid grid-cols-2 gap-2.5">
                  {q.data.properties.map((p) => (
                    <Tile key={p.id} p={p} />
                  ))}
                </div>
              </>
            )}
            <p className="m-0 text-center text-[13px] text-muted-foreground">
              Full dashboards and reports are on the desktop.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
