/* A bottom sheet on the phone: the shared Dialog (focus trap, Escape, outside tap) pinned to the thumb zone. */
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@bide-comply/ui/components/dialog"
import * as React from "react"

export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissable = true,
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  dismissable?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismissable && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-auto bottom-0 flex max-h-[92dvh] max-w-[480px] translate-y-0 flex-col gap-0 overflow-hidden rounded-t-2xl rounded-b-none border-0 bg-surface p-0 sm:max-w-[480px]"
      >
        <div className="shrink-0 px-5 pt-5">
          <DialogTitle className="text-[19px] leading-snug">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="mt-1 text-[14.5px]">{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{typeof title === "string" ? title : ""}</DialogDescription>
          )}
        </div>
        {/* The body scrolls; the buttons stay pinned above the keyboard and the home bar. */}
        {children && (
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pt-4 pb-1">
            {children}
          </div>
        )}
        {footer && <div className="pb-safe-4 mt-4 flex shrink-0 gap-2 border-t border-divider px-5 pt-3">{footer}</div>}
      </DialogContent>
    </Dialog>
  )
}
