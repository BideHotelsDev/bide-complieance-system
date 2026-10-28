/*
 * "Add to Home Screen" (§10.8). On iPhone, web push only works once the app is on the Home Screen, so we say how.
 * Android and desktop Chrome offer their own install prompt, which we surface as a button. Dismissed for good.
 */
import { Share, X } from "lucide-react"
import * as React from "react"

const KEY = "bc-install-hint-dismissed"

type InstallEvent = Event & { prompt: () => Promise<void> }
let deferred: InstallEvent | null = null
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault()
  deferred = e as InstallEvent
})

function standalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function InstallHint() {
  const [hidden, setHidden] = React.useState(() => {
    try {
      return standalone() || localStorage.getItem(KEY) === "1"
    } catch {
      return standalone()
    }
  })
  const [canPrompt, setCanPrompt] = React.useState(() => deferred !== null)
  React.useEffect(() => {
    const on = () => setCanPrompt(true)
    window.addEventListener("beforeinstallprompt", on)
    return () => window.removeEventListener("beforeinstallprompt", on)
  }, [])
  if (hidden) return null
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(KEY, "1")
    } catch {
      /* private mode */
    }
  }
  return (
    <aside aria-label="Add to Home Screen" className="relative mt-2 rounded-xl border border-divider bg-surface px-4 py-3.5 pr-12">
      <div className="text-[15px] font-semibold">Add bide Comply to your Home Screen</div>
      <p className="m-0 mt-1 text-[14px] text-muted-foreground">
        {ios ? (
          <>
            Tap <Share aria-label="Share" className="inline size-4 align-[-3px]" />, then Add to Home Screen. Check reminders
            only reach an iPhone once the app is there.
          </>
        ) : (
          "It opens like an app, works with no signal, and can remind you before a check is due."
        )}
      </p>
      {!ios && canPrompt && (
        <button
          type="button"
          className="mt-2 h-11 rounded-lg border border-border px-4 text-[15px] font-semibold"
          onClick={() => {
            void deferred?.prompt()
            dismiss()
          }}
        >
          Add to Home Screen
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="absolute top-1.5 right-1.5 flex size-11 items-center justify-center rounded-full text-muted-foreground"
      >
        <X aria-hidden className="size-4" />
      </button>
    </aside>
  )
}
