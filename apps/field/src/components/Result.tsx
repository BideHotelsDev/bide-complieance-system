/*
 * After a failed check (design: AppResult, EXE-05). Says what happens next: the Action, its owner, who has been told,
 * and that reporting a fail never costs the person their streak.
 */
import { Link } from "@tanstack/react-router"
import { Bell, ChartNoAxesColumn, Shield, TriangleAlert } from "lucide-react"
import * as React from "react"

import { listWords } from "@/lib/format"
import type { SubmitResult, TaskDetail } from "@/lib/types"

import { Page } from "./kit"

export function FailedResult({ task, result }: { task: TaskDetail; result: SubmitResult }) {
  const rs = result.result_screen
  const classA = task.class === "A"
  const what = result.failed_fields.map((f) => f.text.replace(/\.$/, ""))
  const alerted = rs?.alerted ?? []
  const heading = React.useRef<HTMLHeadingElement>(null)
  React.useEffect(() => heading.current?.focus(), [])
  return (
    <Page>
      <main className="flex flex-1 flex-col px-[22px] pt-10 pb-6">
        <span className="flex size-[52px] items-center justify-center rounded-xl bg-st-red-bg text-st-red">
          <TriangleAlert aria-hidden className="size-6" />
        </span>
        <h1 ref={heading} tabIndex={-1} className="m-0 mt-4 text-[24px] leading-tight font-semibold outline-none">
          {rs?.title ?? "Logged as Failed. Thank you for reporting it."}
        </h1>
        <p className="m-0 mt-2 text-[16px] leading-snug text-muted-foreground">
          {what.length ? `${what.join(". ")}. ` : ""}
          {classA
            ? "This is a life-safety problem, so it has gone straight to the people who fix it."
            : "It has gone to the people who fix it."}
        </p>
        {result.action && (
          <div className="mt-5 rounded-xl border border-st-red/30 bg-st-red-bg/40 px-4 py-3.5">
            <span className="inline-flex h-6 items-center rounded-full border border-foreground px-2 text-[12.5px] font-semibold">
              {rs ? `${rs.priority_label} · ${rs.due_label}` : result.action.ref}
            </span>
            <div className="mt-2 text-[16px] leading-snug font-semibold">{what[0] ?? task.title}</div>
            <div className="mt-1 text-[14.5px] text-muted-foreground">
              {result.action.owner ? `Owner: ${result.action.owner} · ` : ""}raised automatically from your check
              <span className="mono-id ml-1">{result.action.ref}</span>
            </div>
          </div>
        )}
        <ul className="m-0 mt-5 flex list-none flex-col gap-4 p-0 text-[15.5px] leading-snug">
          {alerted.length > 0 && (
            <Line icon={<Bell aria-hidden className="size-4" />}>
              <strong>{listWords(alerted)}</strong> {alerted.length === 1 ? "has" : "have"} been alerted.
              {classA ? " Someone will phone you today." : ""}
            </Line>
          )}
          {classA && (
            <Line icon={<Shield aria-hidden className="size-4" />}>
              Keep the building's normal fire procedures in place. If there is a fire, call 999 yourself.
            </Line>
          )}
          <Line icon={<ChartNoAxesColumn aria-hidden className="size-4" />}>
            Reporting a fail scores the same as a pass. <strong>Your streak is safe.</strong>
          </Line>
        </ul>
      </main>
      <footer className="pb-safe sticky bottom-0 flex flex-col gap-2.5 border-t border-divider bg-surface px-4 pt-3 pb-4">
        <Link
          to="/"
          className="flex h-[52px] items-center justify-center rounded-xl bg-primary text-[17px] font-semibold text-primary-foreground no-underline"
        >
          Back to Today
        </Link>
        <Link
          to="/report"
          className="flex h-12 items-center justify-center rounded-xl border border-border bg-surface text-[16px] font-semibold text-foreground no-underline"
        >
          Add a note or photo
        </Link>
      </footer>
    </Page>
  )
}

function Line({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-hover">{icon}</span>
      <span className="pt-1">{children}</span>
    </li>
  )
}
