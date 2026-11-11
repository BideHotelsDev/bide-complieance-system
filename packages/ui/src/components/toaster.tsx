/*
 * Small confirmations at the bottom of the screen (design: Dialogs › Small confirmations). Toasts confirm; they never
 * carry a decision. Errors stay until closed. Undo is offered for anything reversible.
 */
import { Toaster as Sonner, toast } from "sonner"

/*
 * `position` and `mobileBottom` keep toasts off each app's own controls: the web app lifts them above the phone tab
 * bar; the staff app shows them at the top, clear of the tab bar and the sticky Submit footers.
 */
export function Toaster({
  position = "bottom-center",
  mobileBottom = 16,
}: {
  position?: "bottom-center" | "top-center"
  mobileBottom?: number
}) {
  return (
    <Sonner
      position={position}
      duration={5000}
      mobileOffset={{ bottom: `calc(${mobileBottom}px + env(safe-area-inset-bottom))`, top: 16, left: 16, right: 16 }}
      toastOptions={{
        classNames: {
          toast:
            "!bg-[var(--c-foreground)] !text-[var(--c-background)] !border-0 !rounded-lg !text-[13.5px] !shadow-lg !font-sans",
          actionButton: "!bg-transparent !text-[var(--c-background)] !underline !font-medium",
          description: "!text-[var(--c-subtle)]",
          closeButton: "!size-7",
        },
      }}
    />
  )
}

/* Errors look like errors (red, with a mark), stay until closed, and are announced at once. */
export function toastError(message: string, retry?: () => void) {
  toast.error(message, {
    duration: Infinity,
    closeButton: true,
    icon: (
      <span aria-hidden className="font-bold">
        !
      </span>
    ),
    className: "!bg-st-red !text-on-status",
    action: retry ? { label: "Try again", onClick: retry } : undefined,
  })
}

export { toast }
