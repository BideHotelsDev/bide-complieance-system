/* Staff privacy notice at first sign-in (§9.7). The wording is edited in Settings › Messages and wording. */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Dialog as DialogPrimitive } from "radix-ui"

import { api } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"

export const PRIVACY_TEXT =
  "bide Comply records the checks you do, the photos you take, the time, and your location once at the moment you send a check, so inspectors can see the work was done. It never tracks where you are. Your manager and the compliance team can see your own numbers; nobody else can. Ask Samantha for a copy of anything held about you."

export function PrivacyNotice() {
  const qc = useQueryClient()
  const seen = useMutation({
    mutationFn: () => api.post("/api/me/privacy-notice"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  })
  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <DialogPrimitive.Content
          onEscapeKeyDown={(e: KeyboardEvent) => e.preventDefault()}
          onPointerDownOutside={(e: Event) => e.preventDefault()}
          className="fixed top-1/2 left-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-2xl"
        >
          <DialogPrimitive.Title className="m-0 text-[17px] font-semibold">
            What bide Comply records about you
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-[14px] text-ink2">
            {PRIVACY_TEXT}
          </DialogPrimitive.Description>
          <div className="mt-4 flex justify-end">
            <Button onClick={() => seen.mutate()} disabled={seen.isPending}>
              I've read this
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
