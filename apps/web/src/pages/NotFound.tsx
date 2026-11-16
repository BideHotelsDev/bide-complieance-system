/* Unknown addresses, missing records and pages someone can't open: a real page inside the app, with a heading and a way back. */
import { Link } from "@tanstack/react-router"
import { Button } from "@bide-comply/ui/components/button"
import { Lock, SearchX } from "lucide-react"

export function NotFoundPage({
  title = "We can't find that page",
  message = "The link may be old, or the page has moved. Nothing has been lost.",
  back = { to: "/", label: "Go to Home" },
  icon = "missing",
}: {
  title?: string
  message?: string
  back?: { to: string; label: string }
  icon?: "missing" | "lock"
}) {
  const Icon = icon === "lock" ? Lock : SearchX
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-16 text-center">
      <Icon aria-hidden className="mb-1 size-7 text-subtle" />
      <h1 className="m-0 text-[20px] font-semibold">{title}</h1>
      <p className="m-0 text-[14px] text-muted-foreground">{message}</p>
      <Button asChild className="mt-3">
        <Link to={back.to}>{back.label}</Link>
      </Button>
    </div>
  )
}
