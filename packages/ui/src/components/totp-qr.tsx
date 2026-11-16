/*
 * Authenticator setup: the QR code to scan, with the key to type in under "Can't scan?" (UX audit F6). The API draws
 * the SVG (segno, as on Bide Hub) with its own white quiet zone and a viewBox, so it fills whatever box shows it.
 */
import { cn } from "../lib/utils"

export function TotpQr({
  secret,
  svg,
  uri,
  className,
}: {
  secret?: string
  svg?: string
  /** otpauth:// link: on a phone the QR code is on the same screen, so offer to open the app instead. */
  uri?: string
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      {svg ? (
        <div
          role="img"
          aria-label="QR code to scan with your authenticator app"
          className="size-48 overflow-hidden rounded-lg border border-divider bg-white [&_svg]:block [&_svg]:size-full [&_svg]:[shape-rendering:crispEdges]"
          // Drawn by our API from the secret it just made; contains no user input.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div aria-hidden className="size-48 animate-pulse rounded-lg bg-hover" />
      )}
      {uri && (
        <a href={uri} className="text-[14px] text-link">
          Open in your authenticator app
        </a>
      )}
      {secret && (
        <details className="w-full text-[13px] text-muted-foreground">
          <summary className="inline-flex min-h-6 cursor-pointer items-center text-link">Can't scan?</summary>
          <p className="m-0 mt-1">Choose “Enter a setup key” in the app and type this key:</p>
          <p className="m-0 mt-1 rounded-md bg-hover px-3 py-2 font-mono text-[13px] break-all text-foreground">
            {secret}
          </p>
        </details>
      )}
    </div>
  )
}
