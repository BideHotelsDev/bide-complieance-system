/*
 * David's group table (DSH-01): one group row, then one row per property. The same rows go to Export.
 */
import { useRouter } from "@tanstack/react-router"

import { RagBadge } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import type { Overview, PropertySummary } from "./home-shared"

export const GROUP_COLUMNS = [
  { key: "property", label: "Property" },
  { key: "status", label: "Status" },
  { key: "score", label: "Score %" },
  { key: "overdue", label: "Overdue" },
  { key: "class_a_overdue", label: "Overdue Class A" },
  { key: "due_14", label: "Due in 14 days" },
  { key: "urgent_open", label: "Urgent actions open" },
  { key: "certs_60", label: "Certificates expiring in 60 days" },
  { key: "days_since_alarm_test", label: "Days since last alarm test" },
]

export function tableProperties(o: Overview): PropertySummary[] {
  return o.properties.filter((p) => p.stage !== "setup")
}

function worstAlarm(props: PropertySummary[]): number | null {
  const known = props.map((p) => p.days_since_alarm_test).filter((d): d is number => d != null)
  return known.length ? Math.max(...known) : null
}

export function exportRows(o: Overview): Record<string, string | number | null>[] {
  const props = tableProperties(o)
  return [
    {
      property: `Group (${props.length} properties)`,
      status: "",
      score: o.group.score,
      overdue: o.group.overdue,
      class_a_overdue: o.group.class_a_late,
      due_14: o.group.due_14,
      urgent_open: o.group.urgent_open,
      certs_60: o.group.certs_60,
      days_since_alarm_test: worstAlarm(props),
    },
    ...props.map((p) => ({
      property: p.name,
      status: p.status_label,
      score: p.score,
      overdue: p.checks.late,
      class_a_overdue: p.class_a_late,
      due_14: p.due_14,
      urgent_open: p.actions.urgent,
      certs_60: p.certs_60,
      days_since_alarm_test: p.days_since_alarm_test,
    })),
  ]
}

const TH = "h-[34px] border-b border-divider bg-background px-2.5 py-1.5 align-bottom text-left text-xs leading-tight font-medium text-muted-foreground"
const TD = "border-b border-divider px-2.5 py-2.5 whitespace-nowrap"

export function GroupTable({ overview }: { overview: Overview }) {
  const router = useRouter()
  const props = tableProperties(overview)
  const g = overview.group
  const alarm = worstAlarm(props)
  const open = (p: PropertySummary) =>
    void router.navigate({ href: p.register_loaded || p.stage === "trading" ? `/properties/${p.code}` : `/gates/${p.code}` })
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse text-[13.5px]">
        <caption className="sr-only">Group table: one row per property</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>
              Property
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Score
            </th>
            <th scope="col" className={cn(TH, "text-right")} title="Checks overdue, with life-safety (Class A) in brackets">
              Overdue (Class A)
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Due in 14 days
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Urgent actions
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Certificates in 60 days
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Days since alarm test
            </th>
          </tr>
        </thead>
        <tbody className="tabular">
          <tr className="bg-hover/50 font-semibold">
            <th scope="row" className={cn(TD, "text-left")}>
              Group <span className="font-normal text-muted-foreground">· {props.length} properties</span>
            </th>
            <td className={cn(TD, "text-right")}>{g.score == null ? "—" : `${g.score}%`}</td>
            <td className={cn(TD, "text-right")}>
              {g.overdue} <span className="text-muted-foreground">({g.class_a_late})</span>
            </td>
            <td className={cn(TD, "text-right")}>{g.due_14}</td>
            <td className={cn(TD, "text-right")}>{g.urgent_open}</td>
            <td className={cn(TD, "text-right")}>{g.certs_60}</td>
            <td className={cn(TD, "text-right")} title="The longest gap at any property">
              {alarm ?? "—"}
            </td>
          </tr>
          {props.map((p) => (
            <tr
              key={p.id}
              tabIndex={0}
              onClick={() => open(p)}
              onKeyDown={(e) => {
                if (e.key === "Enter") open(p)
              }}
              className="cursor-pointer hover:bg-hover/60 focus-visible:outline-2 focus-visible:outline-focus"
            >
              <th scope="row" className={cn(TD, "text-left font-medium")}>
                <span className="flex items-center gap-2">
                  {p.name}
                  <RagBadge status={p.score_status} label={p.status_label} />
                </span>
              </th>
              <td className={cn(TD, "text-right")}>{p.score == null ? "—" : `${p.score}%`}</td>
              <td className={cn(TD, "text-right")}>
                {p.register_loaded ? (
                  <>
                    {p.checks.late}{" "}
                    <span className={cn(p.class_a_late ? "font-semibold text-st-red" : "text-muted-foreground")}>
                      ({p.class_a_late})
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className={cn(TD, "text-right")}>{p.due_14}</td>
              <td className={cn(TD, "text-right")}>{p.actions.urgent}</td>
              <td className={cn(TD, "text-right")}>{p.certs_60}</td>
              <td className={cn(TD, "text-right")}>{p.days_since_alarm_test ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
