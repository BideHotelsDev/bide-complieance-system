/* Compliance library helpers shared by the library list and the form builder. */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { toast } from "@bide-comply/ui/components/toaster"

import { plural } from "../../lib/format"
import { ActionDialog, errMsg, Labeled, TextInput } from "./ui"

export type LibraryOptions = {
  domains: { id: string; key: string; name: string }[]
  classes: { key: string; name: string; weight: number }[]
  frequencies: { key: string; label: string; mode: string }[]
  windows: Record<string, number>
  kinds: { key: string; label: string }[]
  field_types: string[]
  features: string[]
}

export function useLibraryOptions() {
  return useQuery({
    queryKey: ["library-options"],
    queryFn: () => api.get<LibraryOptions>("/api/library/options"),
    staleTime: 5 * 60_000,
  })
}

export function ArchiveDialog({
  row,
  onClose,
  onDone,
}: {
  row: { id: string; name: string; used_at: number }
  onClose: () => void
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const [reason, setReason] = React.useState("")
  const check = useQuery({
    queryKey: ["archive-check", row.id],
    queryFn: () => api.get<{ past_records: number; deletable: boolean }>(`/api/library/${row.id}/archive-check`),
  })
  const m = useMutation({
    mutationFn: () => api.post<{ past_records: number }>(`/api/library/${row.id}/archive`, { reason }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["library"] })
      toast(`Archived “${row.name}”. ${plural(r.past_records, "past record")} kept.`)
      onClose()
      onDone?.()
    },
    onError: (e) => toast(errMsg(e)),
  })
  const n = check.data?.past_records
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={m.isPending}
      title="Archive this check?"
      subtitle={`${row.name} · ${row.used_at ? `used at ${plural(row.used_at, "property", "properties")}` : "not used at any property"}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="border-st-red/50 text-st-red hover:bg-st-red-bg"
            disabled={!reason.trim() || m.isPending}
            onClick={() => m.mutate()}
          >
            {m.isPending ? "Archiving…" : "Archive check"}
          </Button>
        </>
      }
    >
      <p className="m-0">
        {n == null
          ? "Checking its past records…"
          : n > 0
            ? `It has ${plural(n, "past record")}, so it can't be deleted. Archiving will:`
            : "It has no past records yet. Archiving will:"}
      </p>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
        <li>Stop it appearing in anyone's Today list</li>
        <li>Keep every past record for inspections</li>
        <li>Let you bring it back later</li>
      </ul>
      <Labeled label="Reason" htmlFor="arch-reason">
        <TextInput
          id="arch-reason"
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Pool removed in refurbishment"
        />
      </Labeled>
    </ActionDialog>
  )
}
