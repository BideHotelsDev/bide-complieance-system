/* Staff privacy notice at first sign-in (§9.7). The wording is edited in Settings › Messages and wording. */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Dialog as DialogPrimitive } from "radix-ui"

import { api } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { useContact } from "@bide-comply/ui/lib/contact"

import { useWording } from "@/lib/wording"

const privacyText = (contact: string) =>
  `Bide Comply records the checks you do, the photos you take, the time, and your location once at the moment you send a check, so inspectors can see you did the work. It never tracks where you are. Your manager and the compliance team can see your own numbers; nobody else can. Ask ${contact} for a copy of anything we hold about you.`

export function PrivacyNotice() {
  const qc = useQueryClient()
  // The published wording from Settings › Messages and wording; the built-in text until it loads.
  const words = useWording()
  const contact = useContact(false)
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
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface p-5 shadow-2xl"
        >
          <DialogPrimitive.Title className="m-0 text-[17px] font-semibold">
            What Bide Comply records about you
          </DialogPrimitive.Title>
          {/* It can't be dismissed, so on a small phone the wording scrolls and the button always stays reachable. */}
          <DialogPrimitive.Description className="mt-2 min-h-0 overflow-y-auto overscroll-contain text-[14px] text-ink2">
            {words.data?.privacy_notice || privacyText(contact)}
          </DialogPrimitive.Description>
          {seen.isError && (
            <p role="alert" className="m-0 mt-3 shrink-0 text-[13px] text-st-red">
              That didn't save. Check your connection and try again.
            </p>
          )}
          <div className="mt-4 flex shrink-0 justify-end">
            <Button onClick={() => seen.mutate()} disabled={seen.isPending}>
              I've read this
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
