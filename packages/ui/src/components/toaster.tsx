/*
 * Small confirmations at the bottom of the screen (design: Dialogs › Small confirmations). Toasts confirm; they never
 * carry a decision. Errors stay until closed. Undo is offered for anything reversible.
 */
import { Toaster as Sonner, toast } from "sonner"

export function Toaster() {
  return (
    <Sonner
      position="bottom-center"
      duration={5000}
      toastOptions={{
        classNames: {
          toast:
            "!bg-[var(--c-foreground)] !text-[var(--c-background)] !border-0 !rounded-lg !text-[13.5px] !shadow-lg !font-sans",
          actionButton: "!bg-transparent !text-[var(--c-background)] !underline !font-medium",
          description: "!text-[var(--c-subtle)]",
        },
      }}
    />
  )
}

export function toastError(message: string, retry?: () => void) {
  toast(message, {
    duration: Infinity,
    closeButton: true,
    action: retry ? { label: "Try again", onClick: retry } : undefined,
  })
}

export { toast }
