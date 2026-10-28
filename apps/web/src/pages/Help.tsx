/*
 * Help and guides, and the 2-minute first-run tour (the sidebar's "Start tour" opens this page): where things are,
 * what the colours mean, the five golden rules (BH-CMP-001) and the three key flows (design: Site map and key flows).
 * Opening it counts as taking the tour.
 */
import { Link } from "@tanstack/react-router"
import { ArrowRight, Search } from "lucide-react"
import * as React from "react"

import { Card, PageHeader } from "@bide-comply/ui/components/page"
import { ClassBadge, PriorityBadge, RagBadge, TaskBadge } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import { navFor, useMe } from "@/lib/session"

const TOUR_KEY = "bc-tour"

/* Same words as the sidebar and the Navigation design's "Plain-language names" table */
const PLACES: { key: keyof ReturnType<typeof navFor>; to: string; label: string; line: string }[] = [
  { key: "home", to: "/", label: "Home", line: "See where every property stands in ten seconds" },
  {
    key: "todo",
    to: "/todo",
    label: "My to-do",
    line: "Everything waiting for you: checks, actions, reviews, signatures",
  },
  {
    key: "properties",
    to: "/properties",
    label: "Properties",
    line: "Pick a property to see its checks, fixes and certificates",
  },
  { key: "actions", to: "/actions", label: "Actions to fix", line: "Problems found and who is fixing them" },
  { key: "reviews", to: "/reviews", label: "Evidence review", line: "Check the photos and certificates staff sent in" },
  { key: "gates", to: "/gates", label: "Opening checklists", line: "Everything that must be done before guests stay" },
  { key: "signoffs", to: "/signoffs", label: "Sign-offs", line: "Things waiting for a signature or an approval" },
  { key: "scorecard", to: "/scorecard", label: "Team scorecard", line: "Weekly goals and the site league" },
  { key: "reports", to: "/reports", label: "Reports and packs", line: "Make a pack for an inspector or insurer" },
  {
    key: "settings",
    to: "/settings",
    label: "Settings",
    line: "Property setup, alert rules, people, wording and appearance",
  },
]

const RULES: { title: string; body: string }[] = [
  { title: "No evidence, not done.", body: "A tick without a photo, scan or certificate is not accepted." },
  {
    title: "One name per item.",
    body: "Every item has a named accountable person. “Housekeeping” or “TBC” is rejected.",
  },
  {
    title: "File it the same day.",
    body: "Evidence is captured at the time of the work and named automatically “What - Who - Date”.",
  },
  {
    title: "Fails are reported, not hidden.",
    body: "A failed check creates an Action straight away and never costs the person points.",
  },
  { title: "One live version.", body: "Records are edited in place with full history; nothing is copied." },
]

type Step = { who: string; title: string; body: string; tone?: "fail" | "result" }
const FLOWS: { title: string; steps: Step[] }[] = [
  {
    title: "A routine check, start to finish",
    steps: [
      { who: "Staff app", title: "Check appears in Today", body: "Assigned to person and property" },
      { who: "Staff app", title: "Answer and take photo", body: "Photo is required; works offline" },
      { who: "System", title: "Record is locked", body: "Time, GPS and person stamped" },
      { who: "Manager · optional", title: "Evidence review", body: "Approve, or send back with a reason" },
      { who: "Result", title: "Status turns green", body: "Score and scorecard update", tone: "result" },
    ],
  },
  {
    title: "Something fails",
    steps: [
      { who: "Staff app", title: "Check fails", body: "Or a hazard is reported", tone: "fail" },
      { who: "System", title: "Action created", body: "Urgent 7 days · Soon 30 · Later 90" },
      { who: "Alert rules", title: "People are told", body: "Manager, then David if it's not moving" },
      { who: "Portal", title: "Fixed with proof", body: "Can't close without evidence" },
      { who: "Result", title: "Action closed", body: "The person who found it isn't penalised", tone: "result" },
    ],
  },
  {
    title: "Getting a property ready to open",
    steps: [
      { who: "Settings", title: "Property set up", body: "Register loaded from the Sheet" },
      { who: "Portal", title: "Opening checklist", body: "56 items in sections A to H" },
      { who: "Portal", title: "All A items done", body: "Status: Ready to open" },
      { who: "SPV dutyholder", title: "Signs it off", body: "bide does, the SPV signs" },
      { who: "Result", title: "Trading", body: "Routine checks start on day one", tone: "result" },
    ],
  },
]

const SECTIONS = [
  { id: "where", label: "Where things are" },
  { id: "colours", label: "What the colours mean" },
  { id: "rules", label: "The five golden rules" },
  { id: "flows", label: "Three key flows" },
]

export function HelpPage() {
  const me = useMe().data
  // This page is the tour: opening it marks the tour as taken, so the sidebar stops offering it.
  React.useEffect(() => {
    try {
      localStorage.setItem(TOUR_KEY, "done")
    } catch {
      /* ignore */
    }
  }, [])
  const show = me ? navFor(me) : null
  const places = PLACES.filter((p) => !show || show[p.key])

  return (
    <div className="flex max-w-[1100px] flex-col gap-5">
      <PageHeader
        title="Help and guides"
        subtitle="A 2-minute tour of where things are and what the colours mean, the five golden rules, and the three journeys the whole system is built around."
      />
      <nav aria-label="On this page" className="flex flex-wrap gap-2">
        {SECTIONS.map((s, i) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-surface px-3 text-[13px] font-medium text-foreground no-underline hover:bg-hover"
          >
            <span className="tabular text-muted-foreground">{i + 1}</span>
            {s.label}
          </a>
        ))}
      </nav>

      <Section
        id="where"
        n={1}
        title="Where things are"
        sub="The menu uses everyday words. Hover over any item in the sidebar for the same line."
      >
        <ul className="m-0 list-none p-0">
          {places.map((p) => (
            <li
              key={p.to}
              className="grid grid-cols-1 gap-x-6 gap-y-0.5 border-b border-divider px-4 py-3 last:border-b-0 sm:grid-cols-[200px_1fr]"
            >
              <Link to={p.to} className="font-semibold text-foreground no-underline hover:underline">
                {p.label}
              </Link>
              <span className="text-muted-foreground">{p.line}</span>
            </li>
          ))}
          <li className="grid grid-cols-1 gap-x-6 gap-y-0.5 border-b border-divider px-4 py-3 sm:grid-cols-[200px_1fr]">
            <span className="flex items-center gap-2 font-semibold">
              <Search className="size-4 text-muted-foreground" aria-hidden />
              Search anything
              <kbd className="rounded border border-border bg-surface px-1.5 text-[11px] font-normal text-muted-foreground">
                ⌘K
              </kbd>
            </span>
            <span className="text-muted-foreground">
              Find a property, check, Action or person from anywhere. Ctrl+K on Windows.
            </span>
          </li>
          <li className="grid grid-cols-1 gap-x-6 gap-y-0.5 px-4 py-3 sm:grid-cols-[200px_1fr]">
            <span className="font-semibold">Property switcher</span>
            <span className="text-muted-foreground">
              At the top of the sidebar. Pick a property and every page follows it, so you never filter by property
              twice.
            </span>
          </li>
        </ul>
      </Section>

      <Section
        id="colours"
        n={2}
        title="What the colours mean"
        sub="Colour is never the only signal: every badge carries its word."
      >
        <div className="grid gap-px overflow-hidden bg-divider md:grid-cols-3">
          <Legend title="Status of a check">
            <LegendRow badge={<RagBadge status="green" />} text="In date" />
            <LegendRow badge={<RagBadge status="amber" />} text="Due soon" />
            <LegendRow badge={<RagBadge status="red" />} text="Overdue" />
            <LegendRow badge={<RagBadge status="grey" />} text="N/A, switched off for this property" />
          </Legend>
          <Legend title="Class of an item">
            <LegendRow
              badge={<ClassBadge klass="A" />}
              text="Class A · Life safety. Overdue turns the whole property red."
            />
            <LegendRow badge={<ClassBadge klass="B" />} text="Class B · Statutory. The law requires it." />
            <LegendRow badge={<ClassBadge klass="C" />} text="Class C · bide standard. Our own good practice." />
          </Legend>
          <Legend title="Priority of an Action">
            <LegendRow badge={<PriorityBadge priority="high" />} text="Fix within 7 days" />
            <LegendRow badge={<PriorityBadge priority="med" />} text="Fix within 30 days" />
            <LegendRow badge={<PriorityBadge priority="low" />} text="Fix within 90 days" />
          </Legend>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-divider px-4 py-3 text-[13px] text-muted-foreground">
          <span>A single check moves through:</span>
          <TaskBadge status="scheduled" />
          <TaskBadge status="due_soon" />
          <TaskBadge status="overdue" />
          <TaskBadge status="submitted" />
          <TaskBadge status="verified" />
          <span>or</span>
          <TaskBadge status="failed" />
          <span>which raises an Action.</span>
        </div>
      </Section>

      <Section
        id="rules"
        n={3}
        title="The five golden rules"
        sub="From the compliance policy (BH-CMP-001). The system enforces them, so you don't have to remember."
      >
        <ol className="m-0 list-none p-0">
          {RULES.map((r, i) => (
            <li key={r.title} className="flex gap-4 border-b border-divider px-4 py-3.5 last:border-b-0">
              <span className="tabular inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[13px] font-semibold text-primary-foreground">
                {i + 1}
              </span>
              <span>
                <strong className="font-semibold">{r.title}</strong>{" "}
                <span className="text-muted-foreground">{r.body}</span>
              </span>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="flows" n={4} title="Three key flows" sub="The three journeys the whole system is built around.">
        <div className="flex flex-col gap-5 p-4">
          {FLOWS.map((f, i) => (
            <div key={f.title}>
              <h3 className="m-0 mb-2.5 text-[13.5px] font-medium">
                {i + 1} · {f.title}
              </h3>
              <ol className="m-0 grid list-none gap-2 p-0 lg:grid-cols-[repeat(5,minmax(0,1fr))]">
                {f.steps.map((s, j) => (
                  <li key={s.title} className="relative flex">
                    <div
                      className={cn(
                        "flex min-h-[104px] flex-1 flex-col rounded-lg border p-3.5",
                        s.tone === "result" && "border-primary bg-primary text-primary-foreground",
                        s.tone === "fail" && "border-st-red/30 bg-st-red-bg/50",
                        !s.tone && "border-border bg-surface",
                      )}
                    >
                      <span
                        className={cn(
                          "text-[11px] font-semibold tracking-[0.06em] uppercase",
                          s.tone === "result" ? "opacity-80" : "text-muted-foreground",
                        )}
                      >
                        {s.who}
                      </span>
                      <span className="mt-1.5 font-semibold">{s.title}</span>
                      <span
                        className={cn("mt-1 text-[13px]", s.tone === "result" ? "opacity-80" : "text-muted-foreground")}
                      >
                        {s.body}
                      </span>
                    </div>
                    {j < f.steps.length - 1 && (
                      <ArrowRight
                        aria-hidden
                        className="absolute top-1/2 -right-[13px] z-10 hidden size-4 -translate-y-1/2 text-subtle lg:block"
                      />
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </Section>

      <p className="m-0 text-[13px] text-muted-foreground">
        Still stuck? Ask Samantha (system owner). Your notification and display settings are in{" "}
        <Link to="/me" className="text-link">
          Your account
        </Link>
        .
      </p>
    </div>
  )
}

function Section({
  id,
  n,
  title,
  sub,
  children,
}: {
  id: string
  n: number
  title: string
  sub: string
  children: React.ReactNode
}) {
  return (
    <Card id={id} aria-labelledby={`${id}-h`} className="scroll-mt-4">
      <div className="border-b border-divider px-4 py-3">
        <h2 id={`${id}-h`} className="m-0 text-[15px] font-semibold">
          <span className="tabular mr-2 text-muted-foreground">{n}</span>
          {title}
        </h2>
        <p className="m-0 mt-0.5 text-[13px] text-muted-foreground">{sub}</p>
      </div>
      {children}
    </Card>
  )
}

function Legend({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 bg-surface p-4">
      <h3 className="m-0 text-[13px] font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

function LegendRow({ badge, text }: { badge: React.ReactNode; text: string }) {
  return (
    <div className="flex items-start gap-3 text-[13.5px]">
      <span className="flex w-[76px] shrink-0">{badge}</span>
      <span>{text}</span>
    </div>
  )
}
