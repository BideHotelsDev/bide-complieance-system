/*
 * One certificate beside the list (?sel=<id>), opened from a row, from search or from an expiry reminder: the file
 * itself, where it sits on the register, the fails that keep it from going Green, and the versions it replaced.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api, type ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Dl, ErrorState, SideSheet, Skeleton } from "@bide-comply/ui/components/page"
import { Pill, PriorityBadge, type Tone } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import { EvidenceLink } from "../../lib/evidence"
import { fmtDate } from "../../lib/format"
import { isRequired, type CertRow } from "./certificates-upload"

export type CertDetail = CertRow & {
  register_item_id: string | null
  register_ref: string | null
  evidence_id: string | null
  superseded_by: string | null
  fails: {
    ref: string
    description: string
    status: string
    priority: "high" | "med" | "low" | null
    due_on: string | null
  }[]
  history: CertRow[]
}

export function CertificateSheet({
  id,
  tone,
  canFile,
  onClose,
  onUpload,
}: {
  id: string
  tone: Record<CertRow["status"], Tone>
  canFile: boolean
  onClose: () => void
  onUpload: (c: CertRow) => void
}) {
  const res = useQuery<CertDetail, ApiError>({
    queryKey: ["certificates", "detail", id],
    queryFn: () => api.get<CertDetail>(`/api/certificates/${id}`),
  })
  const c = res.data
  return (
    <SideSheet
      label={c ? `Certificate: ${c.title}` : "Certificate"}
      onClose={onClose}
      header={
        c ? (
          <>
            <Pill tone={tone[c.status]}>{c.status_label}</Pill>
            <span className="truncate text-[12.5px] text-muted-foreground">{c.kind_label}</span>
          </>
        ) : (
          <Skeleton className="h-5 w-32" />
        )
      }
      footer={
        c && canFile && c.property_id && !c.superseded_by ? (
          <Button onClick={() => onUpload(c)}>{isRequired(c) ? "Upload" : "Upload new"}</Button>
        ) : null
      }
    >
      {res.error ? (
        <ErrorState
          title={res.error.status === 404 ? "This certificate wasn't found" : undefined}
          message={res.error.status === 404 ? "It may have been replaced, or you can't see that property." : undefined}
          onRetry={res.error.status === 404 ? undefined : () => void res.refetch()}
        />
      ) : !c ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="m-0 text-[16px] leading-[1.35] font-semibold">{c.title}</h2>
            {c.why && <p className="m-0 mt-0.5 text-[13px] text-muted-foreground">{c.why}</p>}
          </div>
          {c.superseded_by && (
            <p className="m-0 rounded-lg bg-st-grey-bg px-3 py-2 text-[13px]">
              A newer version replaced this one.{" "}
              <Link to="/certificates" search={{ sel: c.superseded_by }} className="text-link">
                Open the current certificate
              </Link>
            </p>
          )}
          <Dl
            items={[
              {
                label: "Property",
                value: c.property_code ? (
                  <Link to="/properties/$code" params={{ code: c.property_code }} className="text-link">
                    {c.property}
                  </Link>
                ) : (
                  (c.property ?? "Group")
                ),
              },
              ...(c.register_ref && c.property_code
                ? [
                    {
                      label: "Register item",
                      value: (
                        <Link
                          to="/properties/$code"
                          params={{ code: c.property_code }}
                          search={{ item: c.register_ref }}
                          className="mono-id text-link"
                        >
                          {c.register_ref}
                        </Link>
                      ),
                    },
                  ]
                : []),
              { label: "Who provides it", value: c.provider ?? "—" },
              { label: "Issued", value: c.issued_on ? fmtDate(c.issued_on) : "—" },
              { label: "Expires", value: c.expires_on ? fmtDate(c.expires_on) : "—" },
            ]}
          />
          <section>
            <h3 className="m-0 mb-2 text-[13.5px] font-semibold">File</h3>
            {c.evidence_id && c.file_name ? (
              <div className="flex items-center gap-2.5 rounded-lg border border-divider p-2.5">
                <span className="inline-flex h-10 w-8 shrink-0 items-center justify-center rounded bg-hover text-[10px] font-semibold text-muted-foreground">
                  PDF
                </span>
                <EvidenceLink id={c.evidence_id} className="min-w-0 flex-1 truncate font-medium">
                  {c.file_name}
                </EvidenceLink>
              </div>
            ) : (
              <p className="m-0 text-[13px] text-muted-foreground">
                Not on file yet.{canFile ? " Upload it to file it against the register." : ""}
              </p>
            )}
          </section>
          {(c.fails.length > 0 || c.action_ref) && (
            <section>
              <h3 className="m-0 mb-2 text-[13.5px] font-semibold">Linked Actions</h3>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {(c.fails.length
                  ? c.fails
                  : [{ ref: c.action_ref!, description: "", status: "open", priority: null, due_on: null }]
                ).map((a) => (
                  <li key={a.ref}>
                    <Link
                      to="/actions"
                      search={{ sel: a.ref }}
                      className="grid grid-cols-[60px_1fr_auto] items-center gap-2 rounded-lg border border-divider p-2.5 text-foreground no-underline hover:bg-hover/50"
                    >
                      <span className="mono-id text-muted-foreground">{a.ref}</span>
                      <span className={cn("min-w-0 text-[13px]", a.status === "closed" && "text-muted-foreground")}>
                        {a.description || "Open the Action"}
                        {a.status === "closed" && " · closed"}
                      </span>
                      {a.priority && a.status !== "closed" ? <PriorityBadge priority={a.priority} /> : <span />}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {c.history.length > 0 && (
            <section>
              <h3 className="m-0 mb-2 text-[13.5px] font-semibold">Earlier versions</h3>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
                {c.history.map((h) => (
                  <li key={h.id} className="flex items-baseline gap-2">
                    {h.evidence_id && h.file_name ? (
                      <EvidenceLink id={h.evidence_id} className="min-w-0 flex-1 truncate">
                        {h.file_name}
                      </EvidenceLink>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{h.title}</span>
                    )}
                    {h.expires_on && (
                      <span className="tabular shrink-0 text-muted-foreground">until {fmtDate(h.expires_on)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </SideSheet>
  )
}
