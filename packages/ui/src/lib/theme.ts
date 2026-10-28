/*
 * The theme comes from the API as a token set (CMS-13) and is applied as CSS variables before first paint. The last
 * theme is cached, so a returning visitor never sees a flash of the default (PRD §11 Design direction).
 */
export type ThemeTokens = {
  light: Record<string, string>
  dark: Record<string, string>
  highContrast?: Record<string, string>
  radius?: number
  density?: "comfortable" | "compact"
  font?: string
}
export type Theme = { version: number; tokens: ThemeTokens; branding: { appName?: string; signinMessage?: string } }

import { useSyncExternalStore } from "react"

const KEY = "bc-theme"
const MODE_KEY = "bc-mode"

// Token names from the API -> CSS variable names in styles.css
const VAR: Record<string, string> = {
  background: "--c-background",
  surface: "--c-surface",
  sidebar: "--c-sidebar",
  foreground: "--c-foreground",
  ink2: "--c-ink2",
  muted: "--c-muted",
  subtle: "--c-subtle",
  border: "--c-border",
  divider: "--c-divider",
  primary: "--c-primary",
  primaryForeground: "--c-primary-foreground",
  accent: "--c-accent",
  focus: "--c-focus",
  hover: "--c-hover",
  green: "--c-green",
  greenBg: "--c-green-bg",
  amber: "--c-amber",
  amberBg: "--c-amber-bg",
  red: "--c-red",
  redBg: "--c-red-bg",
  grey: "--c-grey",
  greyBg: "--c-grey-bg",
  blue: "--c-blue",
  blueBg: "--c-blue-bg",
}
const HEX = /^#[0-9a-fA-F]{6}$/

function block(sel: string, t: Record<string, string> | undefined): string {
  if (!t) return ""
  const lines = Object.entries(t)
    .filter(([k, v]) => VAR[k] && HEX.test(v))
    .map(([k, v]) => `${VAR[k]}:${v}`)
  return lines.length ? `${sel}{${lines.join(";")}}` : ""
}

const FONT_STACK: Record<string, string> = {
  Inter: '"Inter Variable", Inter, system-ui, sans-serif',
  "IBM Plex Sans": '"IBM Plex Sans", system-ui, sans-serif',
  "Source Sans 3": '"Source Sans 3", system-ui, sans-serif',
}

export function applyTheme(theme: Theme, opts: { preview?: boolean } = {}): void {
  const t = theme.tokens
  const css = [
    block(":root", t.light),
    block(".dark", t.dark),
    block(".hc", t.highContrast),
    `:root{--radius:${[4, 6, 8, 10].includes(Number(t.radius)) ? t.radius : 6}px;--font-sans-family:${FONT_STACK[t.font ?? "Inter"] ?? FONT_STACK.Inter}}`,
  ].join("")
  let el = document.getElementById("bc-theme") as HTMLStyleElement | null
  if (!el) {
    el = document.createElement("style")
    el.id = "bc-theme"
    document.head.appendChild(el)
  }
  el.textContent = css
  if (!opts.preview) {
    try {
      localStorage.setItem(KEY, JSON.stringify(theme))
    } catch {
      /* private mode: fine, it just won't be cached */
    }
  }
  if (theme.branding?.appName) document.title = theme.branding.appName
  branding = theme.branding ?? {}
  listeners.forEach((l) => l())
  // The default table density; a person's own setting (data-density-own) wins over it.
  const root = document.documentElement
  if (!root.dataset.densityOwn) root.dataset.density = t.density === "compact" ? "compact" : "comfortable"
}

// The app name and sign-in message from Appearance, for headers and the sign-in page.
let branding: Theme["branding"] = {}
const listeners = new Set<() => void>()

export function useBranding(): { appName: string; signinMessage?: string } {
  const b = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => branding,
  )
  return { appName: b.appName?.trim() || "bide Comply", signinMessage: b.signinMessage?.trim() || undefined }
}

export function applyCachedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const t = JSON.parse(raw) as Theme
    applyTheme(t)
    return t
  } catch {
    return null
  }
}

export type Mode = "light" | "dark" | "system" | "contrast"

export function applyMode(mode: Mode): void {
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.classList.toggle("hc", mode === "contrast")
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

export function savedMode(): Mode {
  try {
    return (localStorage.getItem(MODE_KEY) as Mode) || "system"
  } catch {
    return "system"
  }
}

export async function loadTheme(fetchTheme: () => Promise<Theme>): Promise<void> {
  applyCachedTheme()
  applyMode(savedMode())
  try {
    applyTheme(await fetchTheme())
  } catch {
    /* offline or API down: the cached or built-in theme stays */
  }
}
