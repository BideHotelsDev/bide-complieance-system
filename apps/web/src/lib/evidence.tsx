/*
 * Open a stored evidence file (certificate PDF, photo, signed document) in a new tab. The API hands out a signed
 * link that lasts a few minutes, so it is fetched on click. The tab is opened first, inside the click, so pop-up
 * blockers allow it.
 */
import * as React from "react"

import { api, type ApiError } from "@bide-comply/api-client"
import { toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

export async function openEvidence(id: string) {
  const tab = window.open("about:blank", "_blank")
  try {
    const f = await api.get<{ url: string }>(`/api/evidence/${id}`)
    if (tab) tab.location.href = f.url
    else window.location.href = f.url
  } catch (e) {
    tab?.close()
    toastError((e as ApiError).message || "Couldn't open the file. Try again.")
  }
}

/** A file name that opens the file. Stops the click reaching a clickable row underneath. */
export function EvidenceLink({
  id,
  children,
  className,
}: {
  id: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void openEvidence(id)
      }}
      className={cn(
        "cursor-pointer border-0 bg-transparent p-0 text-left text-link underline-offset-2 hover:underline",
        className,
      )}
    >
      {children}
    </button>
  )
}
