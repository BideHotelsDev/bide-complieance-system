/*
 * Theme draft helpers for Settings › Appearance: token types, the primary swatches from the design, and the CSS
 * variables that scope a draft to the live preview only (never the whole app).
 */
import type * as React from "react"

export type ModeTokens = Record<string, string>
export type DraftTokens = {
  light: ModeTokens
  dark: ModeTokens
  highContrast: ModeTokens
  radius: number
  font: string
  density: "comfortable" | "compact"
  tone: string
  preset?: string | null
}
export type Branding = {
  appName?: string
  signinMessage?: string
  logoLight?: string
  logoDark?: string
  icon?: string
}
export type Check = { label: string; ratio: number; min: number; ok: boolean }
export type ThemeVersion = {
  id: string
  version: number
  status: "live" | "draft" | "retired"
  name: string
  tokens: DraftTokens
  branding: Branding
  published_at: string | null
  by: string | null
  checks: { light?: Check[]; dark?: Check[] }
  publishable: boolean
}
export type AppearanceData = {
  live: ThemeVersion | null
  draft: ThemeVersion | null
  history: ThemeVersion[]
  presets: Record<string, { light: ModeTokens; dark: ModeTokens; default_mode?: string }>
  fonts: string[]
  can_publish: boolean
}

export const SWATCHES = [
  { name: "Ink", light: "#111113", dark: "#EDEDF0" },
  { name: "Harbour", light: "#2D4A8A", dark: "#8FA8E6" },
  { name: "Heather", light: "#5B3A7A", dark: "#B79AD6" },
  { name: "Pine", light: "#1F5A4A", dark: "#7CC4AE" },
  { name: "Gorse", light: "#E8B21A", dark: "#E8B21A" },
] as const

// The default link and focus blue, which Ink keeps (design: Foundations).
const DEFAULT_ACCENT = { light: "#2459C7", dark: "#8FA8E6" }
const INK_DARK = "#111113"
const WHITE = "#FFFFFF"

function lum(hex: string): number {
  const v = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
}
export function ratio(a: string, b: string): number {
  const x = lum(a)
  const y = lum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/* Pick a primary: buttons take it, links and focus follow it (Ink keeps the default blue), and the button text
 * becomes whichever of white or ink reads better on it. */
export function withPrimary(t: DraftTokens, swatch: (typeof SWATCHES)[number]): DraftTokens {
  const mode = (m: "light" | "dark") => {
    const p = swatch[m]
    const fg = ratio(WHITE, p) >= ratio(INK_DARK, p) ? WHITE : INK_DARK
    const accent = swatch.name === "Ink" ? DEFAULT_ACCENT[m] : p
    return { ...t[m], primary: p, primaryForeground: fg, accent, focus: accent }
  }
  return { ...t, light: mode("light"), dark: mode("dark") }
}

export function swatchOf(t: DraftTokens): (typeof SWATCHES)[number] | null {
  return SWATCHES.find((s) => s.light.toUpperCase() === t.light.primary?.toUpperCase()) ?? null
}

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
const FONT_STACK: Record<string, string> = {
  Inter: '"Inter Variable", Inter, system-ui, sans-serif',
  "IBM Plex Sans": '"IBM Plex Sans", system-ui, sans-serif',
  "Source Sans 3": '"Source Sans 3", system-ui, sans-serif',
}

/* CSS variables for one mode of a draft, to put on the preview container's style. */
export function previewVars(t: DraftTokens, mode: "light" | "dark"): React.CSSProperties {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(t[mode] ?? {})) if (VAR[k]) out[VAR[k]] = v
  out["--radius"] = `${t.radius}px`
  out["--font-sans-family"] = FONT_STACK[t.font] ?? FONT_STACK.Inter
  out.fontFamily = out["--font-sans-family"]
  return out as React.CSSProperties
}

export const STATUS_PAIRS = [
  { key: "green", label: "Green" },
  { key: "amber", label: "Amber" },
  { key: "red", label: "Red" },
  { key: "grey", label: "Grey" },
] as const

export const TONES = [
  { value: "plain", label: "Plain and calm (recommended)" },
  { value: "warm", label: "Warm and friendly" },
  { value: "brief", label: "Short and direct" },
]
