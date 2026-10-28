/* History (design: AppHistory). Everything the person has sent in, newest first; checks sent back come first. */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { api, type ApiError } from "@bide-comply/api-client"
import { Pill } from "@bide-comply/ui/components/status"
import { Check } from "lucide-react"

import { Card, ErrorBox, Loading, SectionLabel, TabScreen } from "@/components/kit"
import { WaitingList } from "@/components/sync"
import type { History } from "@/lib/types"

function StatusPill({ status }: { status: string }) {
  if (status === "Verified")
    return (
      <Pill tone="green">
        <Check aria-hidden className="size-3" />
        Verified
      </Pill>
    )
  if (status === "Failed") return <Pill tone="red">Failed</Pill>
  if (status === "Passed") return <Pill tone="green">Passed</Pill>
  if (status === "Sent") return <Pill tone="blue">Being checked</Pill>
  if (status === "Sent back") return <Pill tone="amber">Sent back</Pill>
  return <Pill tone="grey">{status}</Pill>
}

export function HistoryPage() {
  const q = useQuery({ queryKey: ["history"], queryFn: () => api.get<History>("/api/field/history") })
  return (
    <TabScreen title="History" subtitle="Everything you've sent in, newest first">
      <WaitingList />
      {q.isPending ? (
        <Loading label="Loading history" />
      ) : q.error ? (
        <ErrorBox
          message={
            (q.error as ApiError).status === 0
              ? "History needs a signal. Checks waiting on this phone are shown above."
              : q.error.message
          }
          onRetry={() => void q.refetch()}
        />
      ) : (
        <>
          {q.data.send_again.map((s) => (
            <div key={s.task_id} className="rounded-xl border border-st-red/30 bg-st-red-bg/40 px-4 py-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="text-[16.5px] font-semibold">{s.title}</div>
                <Pill tone="red">Send again</Pill>
              </div>
              <p className="m-0 mt-1 text-[15px]">
                {s.by}: "{s.comment}"
              </p>
              <Link
                to="/task/$taskId"
                params={{ taskId: s.task_id }}
                className="mt-3 flex h-12 items-center justify-center rounded-xl border border-border bg-surface text-[16px] font-semibold text-foreground no-underline"
              >
                Retake photo
              </Link>
            </div>
          ))}
          {q.data.groups.map((g) => (
            <section key={g.label} aria-label={g.label} className="flex flex-col gap-2">
              <SectionLabel>{g.label}</SectionLabel>
              <Card>
                <ul className="m-0 list-none p-0">
                  {g.rows.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center gap-3 border-b border-divider px-3.5 py-3 last:border-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[16px] font-semibold">{r.title}</div>
                        <div className="text-[14px] text-muted-foreground">{r.detail}</div>
                      </div>
                      <StatusPill status={r.status} />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
          {!q.data.groups.length && !q.data.send_again.length && (
            <p className="m-0 rounded-xl border border-divider bg-surface px-4 py-6 text-center text-[15px] text-muted-foreground">
              Nothing sent in yet. Checks you send appear here.
            </p>
          )}
        </>
      )}
    </TabScreen>
  )
}
