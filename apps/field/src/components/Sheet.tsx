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
        className="top-auto bottom-0 max-h-[92dvh] max-w-[480px] translate-y-0 gap-0 overflow-y-auto rounded-t-2xl rounded-b-none border-0 bg-surface p-0 sm:max-w-[480px]"
      >
        <div className="px-5 pt-5">
          <DialogTitle className="text-[19px] leading-snug">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="mt-1 text-[14.5px]">{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{typeof title === "string" ? title : ""}</DialogDescription>
          )}
        </div>
        {children && <div className="flex flex-col gap-4 px-5 pt-4">{children}</div>}
        {footer && <div className="pb-safe mt-5 flex gap-2 border-t border-divider px-5 pt-3 pb-4">{footer}</div>}
      </DialogContent>
    </Dialog>
  )
}
