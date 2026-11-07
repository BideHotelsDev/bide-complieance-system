/*
 * The Bide systems menu from Bide Hub (a 3×3-dot button listing every Bide system). Shown only when Sign in with Bide
 * is on; the Hub serves the script, and its styles stay inside the element's shadow root.
 */
import * as React from "react"

import { useBideHub } from "@/lib/session"

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "bide-app-switcher": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        current?: string
        hub?: string
        align?: "start" | "end"
      }
    }
  }
}

function useSwitcherScript(issuer: string | null | undefined) {
  React.useEffect(() => {
    if (!issuer) return
    const src = `${issuer}/switcher.js`
    if (document.querySelector(`script[src="${src}"]`)) return
    const s = document.createElement("script")
    s.src = src
    s.defer = true
    document.head.appendChild(s)
  }, [issuer])
}

export function AppSwitcher({ align = "start", className }: { align?: "start" | "end"; className?: string }) {
  const hub = useBideHub()
  const issuer = hub.data?.enabled ? hub.data.issuer : null
  useSwitcherScript(issuer)
  if (!issuer) return null
  return <bide-app-switcher current="comply" align={align} className={className} />
}
