/*
 * My to-do (design: My to-do): only what is waiting for this person, life safety first. Quick views narrow it;
 * the Class A phone call can be recorded straight from here.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Eye, Flag, Info, PenLine, Phone, Shuffle } from "lucide-react"
import * as React from "react"

import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bide-comply/ui/components/dialog"
import { QuickViews } from "@bide-comply/ui/components/filter-bar"
import { EmptyState, ErrorState, Skeleton } from "@bide-comply/ui/components/page"
import { Pill } from "@bide-comply/ui/components/status"
import { Textarea } from "@bide-comply/ui/components/textarea"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { AppLink, hello, type Todo, type TodoItem } from "@/features/overview/home-shared"
import { fmtDay } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useProperty } from "@/lib/property"
import { navFor, useMe } from "@/lib/session"

type View = "everything" | "decisions" | "reviews" | "actions" | "today"
const VIEWS: { key: View; label: string }[] = [
  { key: "everything", label: "Everything" },
  { key: "decisions", label: "Needs a decision" },
  { key: "reviews", label: "Evidence to review" },
  { key: "actions", label: "My actions" },
  { key: "today", label: "Due today" },
]

type Card = {
  key: string
  tone: "red" | "grey" | "amber" | "blue"
  icon: React.ReactNode
  title: string
  detail: string
  href: string
  button: "Open" | "Review" | "Sign"
  callRef?: string
}

const PRIO = { high: "Urgent", med: "Soon", low: "Later" } as const

const ICON_BG = {
  red: "bg-st-red-bg text-st-red",
  grey: "bg-st-grey-bg text-ink2",
  amber: "bg-st-amber-bg text-st-amber",
  blue: "bg-st-blue-bg text-st-blue",
}

function cardFor(i: TodoItem): Card {
  if (i.kind === "call")
    return {
      key: i.id,
      tone: "red",
      icon: <Phone className="size-[18px]" />,
      title: i.title,
      detail: i.detail,
      href: i.link,
      button: "Open",
      callRef: i.call_due ? i.action_ref : undefined,
    }
  if (i.kind === "approval")
    return {
      key: i.id,
      tone: "amber",
      icon: <Check className="size-[18px]" />,
      title: i.title,
      detail: i.detail,
      href: i.link,
      button: "Review",
    }
  return {
    key: i.id,
    tone: "grey",
    icon: <Flag className="size-[18px]" />,
    title: i.title,
    detail: i.detail,
    href: i.link,
    button: "Open",
  }
}

export function MyTodoPage() {
  const me = useMe()
  const { propertyId } = useProperty()
  const [params, set] = useParams()
  const view = (VIEWS.some((v) => v.key === params.view) ? params.view : "everything") as View
  const q = useQuery<Todo, ApiError>({
    queryKey: ["todo", propertyId],
    queryFn: () => api.get<Todo>("/api/todo", { property: propertyId }),
  })
  const [calling, setCalling] = React.useState<Card | null>(null)
  const t = q.data
  const today = new Date().toISOString().slice(0, 10)

  const signCards: Card[] = (t?.signatures ?? []).map((s) => ({
    key: s.id,
    tone: "amber",
    icon: <PenLine className="size-[18px]" />,
    title: `Sign: ${s.title}`,
    detail: `${s.property}${s.due_on ? ` · due ${fmtDay(s.due_on)}` : ""}`,
    href: `/signoffs?sel=${s.id}`,
    button: "Sign",
  }))
  const nowItems = t?.now ?? []
  let cards: Card[] = []
  if (t) {
    if (view === "everything") cards = [...nowItems.map(cardFor), ...signCards]
    else if (view === "decisions")
      cards = nowItems.filter((i) => i.kind === "approval" || i.kind === "call").map(cardFor)
    else if (view === "today")
      cards = nowItems.filter((i) => i.kind === "call" || (i.due_on && i.due_on <= today)).map(cardFor)
    else if (view === "actions")
      cards = t.mine
        ? t.mine.map((a) => ({
            key: a.id,
            tone: "grey" as const,
            icon: <Flag className="size-[18px]" />,
            title: a.title,
            detail: `Your action · ${a.ref} · ${a.property} · ${PRIO[a.priority]} · due ${fmtDay(a.due_on)}`,
            href: a.link,
            button: "Open" as const,
          }))
        : nowItems.filter((i) => i.kind === "action").map(cardFor)
  }
  const showNow = view !== "reviews"
  const showReviews = view === "everything" || view === "reviews"
  const reviewTotal = t ? t.reviews.pending + t.reviews.spot_check : 0
  const needCount = nowItems.length + signCards.length

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">
            {hello(me.data?.name, me.data?.first_name)}
          </h1>
          <p className="m-0 mt-1 max-w-3xl text-muted-foreground">
            {!t
              ? " "
              : needCount === 0
                ? "Nothing needs you today."
                : `${needCount} ${needCount === 1 ? "thing needs" : "things need"} you today. Start at the top.`}
          </p>
        </div>
        <AppLink
          href="/me"
          className="inline-flex h-9 items-center rounded-lg border border-border bg-surface px-3.5 text-[13.5px] font-medium text-foreground no-underline hover:bg-hover"
        >
          Notification settings
        </AppLink>
      </header>

      {t && (
        <QuickViews
          views={VIEWS.map((v) => ({ key: v.key, label: v.label, count: t.counts[v.key], on: v.key === view }))}
          onPick={(k) => set({ view: k === "everything" ? undefined : k })}
        />
      )}

      {q.isPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-36 rounded-xl" />
        </div>
      ) : q.isError || !t ? (
        <ErrorState message={q.error?.message} onRetry={() => void q.refetch()} />
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
            {showNow && (
              <Section
                id="t1"
                title={view === "actions" ? "My actions" : "Needs you now"}
                count={cards.length}
                countTone="red"
                aside={
                  view === "actions" ? (
                    <AppLink href="/actions" className="text-[13px] text-link no-underline hover:underline">
                      All actions
                    </AppLink>
                  ) : (
                    <span className="text-[12.5px] text-muted-foreground">Life safety, and anything due today</span>
                  )
                }
              >
                {cards.length === 0 ? (
                  <EmptyState title={view === "actions" ? "No open actions are yours" : "Nothing here"}>
                    {view === "everything"
                      ? "You're up to date. Life-safety alerts and decisions will appear here first."
                      : "Nothing in this view needs you. Try Everything."}
                  </EmptyState>
                ) : (
                  cards.map((c) => <Item key={c.key} c={c} onCall={() => setCalling(c)} />)
                )}
              </Section>
            )}

            {showReviews && t.reviews && (me.data?.can.verify || reviewTotal > 0) && (
              <Section
                id="t2"
                title="Waiting for your review"
                count={reviewTotal}
                countTone="blue"
                aside={
                  <AppLink href="/reviews" className="text-[13px] text-link no-underline hover:underline">
                    Open evidence review
                  </AppLink>
                }
              >
                {reviewTotal === 0 ? (
                  <EmptyState title="No evidence waiting">
                    Submissions from staff appear here for a second check.
                  </EmptyState>
                ) : (
                  <>
                    {t.reviews.pending > 0 && (
                      <Row
                        tone="blue"
                        icon={<Eye className="size-[18px]" />}
                        title={`${t.reviews.pending} ${t.reviews.pending === 1 ? "check needs" : "checks need"} review`}
                        detail="Evidence submitted by staff, oldest first. You never review your own."
                        right={
                          <AppLink href="/reviews" className={BTN}>
                            Review
                          </AppLink>
                        }
                      />
                    )}
                    {t.reviews.spot_check > 0 && (
                      <Row
                        tone="blue"
                        icon={<Shuffle className="size-[18px]" />}
                        title="This week's 1-in-10 spot-check is ready"
                        detail={`${t.reviews.spot_check} ${t.reviews.spot_check === 1 ? "submission" : "submissions"} picked at random · about ${Math.max(2, Math.round(t.reviews.spot_check * 1.5))} minutes`}
                        right={
                          <AppLink href="/reviews?queue=spot_check" className={BTN}>
                            Start
                          </AppLink>
                        }
                      />
                    )}
                  </>
                )}
              </Section>
            )}
          </div>

          <aside className="flex max-w-[360px] min-w-0 flex-[1_1_300px] flex-col gap-4">
            <section aria-labelledby="wk" className="overflow-hidden rounded-xl border border-divider bg-surface">
              <div className="flex items-center justify-between gap-2.5 border-b border-divider px-[18px] py-3.5">
                <h2 id="wk" className="m-0 text-[15px] font-semibold">
                  Coming up this week
                </h2>
              </div>
              {t.coming.length === 0 ? (
                <p className="m-0 px-[18px] py-4 text-[13px] text-muted-foreground">Nothing scheduled this week.</p>
              ) : (
                <ol className="m-0 list-none py-1.5 pl-0">
                  {t.coming.map((c, i) => (
                    <li key={i} className="grid grid-cols-[64px_1fr] gap-2.5 px-[18px] py-2">
                      <span className="font-semibold text-muted-foreground">
                        {c.label.split(" ").slice(0, 2).join(" ")}
                      </span>
                      <span>{c.strong ? <strong className="font-semibold">{c.text}</strong> : c.text}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <div className="flex items-start gap-2.5 rounded-[10px] bg-st-grey-bg px-3.5 py-3 text-[13.5px]">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                My to-do only shows what is waiting for <strong className="font-semibold">you</strong>.
                {me.data && navFor(me.data).properties ? (
                  <>
                    {" "}
                    To see everything at a property, use{" "}
                    <AppLink href="/properties" className="text-link">
                      Properties
                    </AppLink>
                    .
                  </>
                ) : (
                  " To see everything your team is working on, use Actions to fix."
                )}
              </span>
            </div>
          </aside>
        </div>
      )}

      {calling && <CallDialog card={calling} onClose={() => setCalling(null)} />}
    </div>
  )
}

const BTN =
  "inline-flex h-[30px] items-center rounded-lg border border-border bg-surface px-2.5 text-[13px] font-medium text-foreground no-underline hover:bg-hover"

function Section({
  id,
  title,
  count,
  countTone,
  aside,
  children,
}: {
  id: string
  title: string
  count: number
  countTone: "red" | "blue"
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="overflow-hidden rounded-xl border border-divider bg-surface">
      <div className="flex items-center justify-between gap-2.5 border-b border-divider px-[18px] py-3.5">
        <h2 id={id} className="m-0 flex items-center text-[15px] font-semibold">
          {title}
          <Pill tone={count ? countTone : "grey"} className="ml-1.5">
            {count}
          </Pill>
        </h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Row({
  tone,
  icon,
  title,
  detail,
  right,
}: {
  tone: Card["tone"]
  icon: React.ReactNode
  title: string
  detail: string
  right: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[36px_1fr_auto] items-center gap-3 border-b border-divider px-[18px] py-3.5 last:border-b-0">
      <span aria-hidden className={cn("inline-flex size-9 items-center justify-center rounded-[10px]", ICON_BG[tone])}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="font-semibold">{title}</span>
        <span className="block text-[12.5px] text-muted-foreground">{detail}</span>
      </span>
      <span className="flex gap-2">{right}</span>
    </div>
  )
}

function Item({ c, onCall }: { c: Card; onCall: () => void }) {
  return (
    <Row
      tone={c.tone}
      icon={c.icon}
      title={c.title}
      detail={c.detail}
      right={
        <>
          <AppLink href={c.href} className={BTN}>
            {c.button}
          </AppLink>
          {c.callRef && (
            <Button size="default" onClick={onCall}>
              Mark call made
            </Button>
          )}
        </>
      }
    />
  )
}

function CallDialog({ card, onClose }: { card: Card; onClose: () => void }) {
  const qc = useQueryClient()
  const [note, setNote] = React.useState("")
  const m = useMutation<{ ok: boolean }, ApiError>({
    mutationFn: () => api.post(`/api/actions/${card.callRef}/call-made`, { note: note.trim() || null }),
    onSuccess: () => {
      toast(`Call recorded for ${card.callRef}`)
      void qc.invalidateQueries({ queryKey: ["todo"] })
      void qc.invalidateQueries({ queryKey: ["overview"] })
      void qc.invalidateQueries({ queryKey: ["mobile-home"] })
      void qc.invalidateQueries({ queryKey: ["nav"] })
      onClose()
    },
    onError: (e) => toastError(e.message),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record the phone call</DialogTitle>
          <DialogDescription>{card.title}</DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink2">Who you spoke to and what was agreed (optional)</span>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
        </label>
        <p className="m-0 text-[12.5px] text-muted-foreground">
          This is saved with your name and the time, and stops the escalation. It can't be undone.
        </p>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>
            {m.isPending ? "Saving…" : "Record the call"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
