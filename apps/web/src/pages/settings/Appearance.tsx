/*
 * Appearance (CMS-13..15, design: Appearance). Edit a draft theme with a live preview scoped to the preview panel,
 * see WCAG 2.2 AA contrast checks from the API, publish only when they all pass, and roll back in one click.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Check as CheckIcon, Lock } from "lucide-react"
import * as React from "react"

import { api, upload, type ApiError } from "@bide-comply/api-client"
import { Callout, ErrorState, NoPermission, PageHeader, Skeleton } from "@bide-comply/ui/components/page"
import { Popover, PopoverContent, PopoverTrigger } from "@bide-comply/ui/components/popover"
import { Pill } from "@bide-comply/ui/components/status"
import { toast } from "@bide-comply/ui/components/toaster"
import { applyTheme, type Theme } from "@bide-comply/ui/lib/theme"
import { cn } from "@bide-comply/ui/lib/utils"

import {
  type AppearanceData,
  type Branding,
  type Check,
  type DraftTokens,
  previewVars,
  STATUS_PAIRS,
  SWATCHES,
  swatchOf,
  type ThemeVersion,
  TONES,
  withPrimary,
} from "../../features/settings-b/theme-draft"
import { ButtonGroup, errText, FieldLabel, NativeSelect } from "../../features/settings-b/ui"
import { fmtDate } from "../../lib/format"
import { useMe } from "../../lib/session"

type Mode = "light" | "dark"
type Overview = {
  kpis: {
    life_safety_open: { value: number }
    high_over_7: { value: number }
    decisions: { advisories: number }
  }
  properties: {
    id: string
    name: string
    score: number | null
    score_status: string
    gate: { status: string } | null
  }[]
  actions_by_urgency: { high: number; med: number; low: number }
}

const PRESETS = [
  { key: "clean_light", label: "Clean light" },
  { key: "clean_dark", label: "Clean dark" },
  { key: "high_contrast", label: "High contrast" },
]
const MAIN_CHECKS = 4

async function refreshAppTheme() {
  // The whole app follows the newly live theme without a reload.
  const t = await api.get<Theme>("/api/theme")
  applyTheme(t)
}

export function AppearancePage() {
  const me = useMe()
  const qc = useQueryClient()
  const q = useQuery<AppearanceData, ApiError>({
    queryKey: ["settings", "appearance"],
    queryFn: () => api.get<AppearanceData>("/api/settings/appearance"),
  })
  const [tokens, setTokens] = React.useState<DraftTokens | null>(null)
  const [branding, setBranding] = React.useState<Branding>({})
  const [checks, setChecks] = React.useState<{ light?: Check[]; dark?: Check[] }>({})
  const [hasDraft, setHasDraft] = React.useState(false)
  const [mode, setMode] = React.useState<Mode>("light")
  const [pending, setPending] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const loaded = React.useRef(false)

  const load = React.useCallback((d: AppearanceData) => {
    const base = d.draft ?? d.live
    if (!base) return
    setTokens(base.tokens)
    setBranding(base.branding ?? {})
    setChecks(base.checks)
    setHasDraft(!!d.draft)
    setPending(false)
  }, [])

  React.useEffect(() => {
    if (q.data && !loaded.current) {
      loaded.current = true
      load(q.data)
    }
  }, [q.data, load])

  const canEdit = !!(me.data?.can["theme.publish"] && q.data?.can_publish)

  const saveDraft = React.useCallback(
    async (t: DraftTokens, b: Branding) => {
      setSaving(true)
      try {
        const sw = swatchOf(t)
        const name = sw ? `${sw.name} primary` : "Custom colours"
        const r = await api.put<{ checks: { light: Check[]; dark: Check[] } }>("/api/settings/appearance/draft", {
          tokens: t,
          branding: b,
          name,
        })
        setChecks(r.checks)
        setHasDraft(true)
        setPending(false)
        void qc.invalidateQueries({ queryKey: ["settings", "appearance"] })
        return true
      } catch (e) {
        toast.error(errText(e))
        return false
      } finally {
        setSaving(false)
      }
    },
    [qc],
  )

  // Every change saves the draft shortly after (never live), and the API sends back the contrast checks.
  React.useEffect(() => {
    if (!pending || !tokens || !canEdit) return
    const h = setTimeout(() => void saveDraft(tokens, branding), 400)
    return () => clearTimeout(h)
  }, [pending, tokens, branding, canEdit, saveDraft])

  const change = (fn: (t: DraftTokens) => DraftTokens) => {
    setTokens((t) => (t ? fn(t) : t))
    setPending(true)
  }
  const changeBrand = (patch: Partial<Branding>) => {
    setBranding((b) => ({ ...b, ...patch }))
    setPending(true)
  }

  const refetchAndLoad = async () => {
    const r = await q.refetch()
    if (r.data) load(r.data)
  }

  const publish = useMutation<{ version: number }, ApiError>({
    mutationFn: async () => {
      if (pending && tokens) {
        const ok = await saveDraft(tokens, branding)
        if (!ok) throw new Error("not saved")
      }
      return api.post<{ version: number }>("/api/settings/appearance/publish")
    },
    onSuccess: async (r) => {
      await refreshAppTheme()
      toast.success(`Theme v${r.version} is live for everyone.`)
      await refetchAndLoad()
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "not saved") return
      toast.error(errText(e))
    },
  })
  const discard = useMutation<unknown, ApiError>({
    mutationFn: () => api.del("/api/settings/appearance/draft"),
    onSuccess: async () => {
      toast.success("Draft discarded. Showing the published theme.")
      await refetchAndLoad()
    },
    onError: (e) => toast.error(errText(e)),
  })
  const rollback = useMutation<{ version: number }, ApiError, number>({
    mutationFn: (v) => api.post<{ version: number }>(`/api/settings/appearance/rollback/${v}`),
    onSuccess: async (r, v) => {
      await refreshAppTheme()
      toast.success(`Rolled back to v${v}. It's live now as v${r.version}.`)
      await refetchAndLoad()
    },
    onError: (e) => toast.error(errText(e)),
  })

  if (me.data && !me.data.can["settings.view"]) return <NoPermission />

  const allChecks = [...(checks.light ?? []), ...(checks.dark ?? [])]
  const publishable = allChecks.length > 0 && allChecks.every((c) => c.ok)
  const modeChecks = checks[mode] ?? []
  const shown = modeChecks.filter((c, i) => i < MAIN_CHECKS || !c.ok)
  const failing = modeChecks.filter((c) => !c.ok)
  const otherFailing = (checks[mode === "light" ? "dark" : "light"] ?? []).filter((c) => !c.ok)
  const busy = publish.isPending || discard.isPending || rollback.isPending

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Appearance"
        subtitle="Colours, logo and font for every screen."
        actions={
          canEdit && (
            <>
              {(hasDraft || pending) && (
                <span className="text-[12px] text-muted-foreground">
                  {saving ? "Saving draft…" : "Draft · not live"}
                </span>
              )}
              <button
                type="button"
                disabled={!hasDraft || busy}
                onClick={() => discard.mutate()}
                className="inline-flex h-[30px] items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium hover:bg-hover disabled:opacity-40"
              >
                Reset to published
              </button>
              <button
                type="button"
                disabled={!(hasDraft || pending) || !publishable || busy || saving}
                title={!publishable ? "Fix the contrast checks first" : undefined}
                onClick={() => publish.mutate()}
                className="inline-flex h-[30px] items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                {publish.isPending ? "Publishing…" : "Publish theme"}
              </button>
            </>
          )
        }
      />

      {q.isError ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : !q.data || !tokens ? (
        <div className="flex flex-wrap gap-5">
          <div className="flex flex-[1_1_360px] flex-col gap-4 lg:max-w-[420px]">
            <Skeleton className="h-36" />
            <Skeleton className="h-48" />
            <Skeleton className="h-96" />
          </div>
          <Skeleton className="h-[440px] flex-[999_1_480px]" />
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <fieldset
            disabled={!canEdit}
            className="m-0 flex min-w-0 flex-[1_1_360px] flex-col gap-4 border-0 p-0 lg:max-w-[420px]"
          >
            {!canEdit && (
              <Callout tone="grey" icon={<Lock className="size-4" />}>
                You can see the theme but not change it. The system owner and Super Admins can.
              </Callout>
            )}
            <Section title="Start from a default theme">
              <div className="grid grid-cols-3 gap-2">
                {PRESETS.map((p) => {
                  const on = tokens.preset === p.key
                  const pt = q.data.presets[p.key]
                  const m = pt?.default_mode === "dark" ? pt.dark : pt?.light
                  const strong = p.key === "high_contrast"
                  const dots = m ? [m.primary, strong ? m.green : m.greenBg, strong ? m.red : m.redBg] : []
                  return (
                    <button
                      key={p.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        const pr = q.data.presets[p.key]
                        if (!pr) return
                        change((t) => ({
                          ...t,
                          light: pr.light,
                          dark: pr.dark,
                          highContrast: q.data.presets.high_contrast?.light ?? t.highContrast,
                          preset: p.key,
                        }))
                        setMode(pr.default_mode === "dark" ? "dark" : "light")
                      }}
                      className={cn(
                        "overflow-hidden rounded-[10px] bg-surface p-0 text-left text-[12.5px]",
                        on ? "border-2 border-foreground" : "border border-border hover:bg-hover",
                      )}
                    >
                      {/* Each card shows that theme's own colours, whatever is live. */}
                      <span
                        className="flex gap-1 p-2.5"
                        style={{
                          background: m?.background,
                          borderBottom: strong && m ? `2px solid ${m.foreground}` : undefined,
                        }}
                      >
                        {dots.map((d, i) => (
                          <span key={i} className="size-3.5 rounded" style={{ background: d }} />
                        ))}
                      </span>
                      <span className="block px-2.5 py-1.5 font-semibold">{p.label}</span>
                    </button>
                  )
                })}
              </div>
              <Hint>
                All three use Inter, the clean default font. Staff can also follow their phone's light or dark setting.
              </Hint>
            </Section>

            <Section title="Brand">
              <div>
                <FieldLabel htmlFor="app-name">App name</FieldLabel>
                <input
                  id="app-name"
                  value={branding.appName ?? ""}
                  maxLength={40}
                  onChange={(e) => changeBrand({ appName: e.target.value })}
                  className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] outline-none focus:outline-2 focus:outline-focus"
                />
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <LogoSlot
                  label="Logo · light"
                  id={branding.logoLight}
                  tone="light"
                  colours={tokens.light}
                  onDone={(id) => changeBrand({ logoLight: id })}
                />
                <LogoSlot
                  label="Logo · dark"
                  id={branding.logoDark}
                  tone="dark"
                  colours={tokens.dark}
                  onDone={(id) => changeBrand({ logoDark: id })}
                />
                <LogoSlot
                  label="App icon"
                  id={branding.icon}
                  tone="icon"
                  colours={tokens.light}
                  onDone={(id) => changeBrand({ icon: id })}
                />
              </div>
              <Hint>PNG, WebP or SVG under 1 MB. SVGs are cleaned of scripts before use.</Hint>
            </Section>

            <Section title="Colour">
              <div>
                <FieldLabel>Preview mode</FieldLabel>
                <ButtonGroup<Mode>
                  label="Preview mode"
                  value={mode}
                  onChange={setMode}
                  disabled={false}
                  options={[
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                />
              </div>
              <div>
                <FieldLabel>Primary</FieldLabel>
                <div role="group" aria-label="Primary colour" className="flex flex-wrap gap-1.5">
                  {SWATCHES.map((s) => {
                    const on = tokens.light.primary?.toUpperCase() === s.light.toUpperCase()
                    return (
                      <button
                        key={s.name}
                        type="button"
                        aria-pressed={on}
                        onClick={() => change((t) => withPrimary(t, s))}
                        className="flex flex-col items-center gap-1.5 rounded-md p-1 text-[12px] text-ink2"
                      >
                        <span
                          className={cn(
                            "block size-10 rounded-[10px]",
                            on
                              ? "shadow-[0_0_0_2px_var(--c-surface),0_0_0_4px_var(--c-focus)]"
                              : "shadow-[inset_0_0_0_1px_rgba(0,0,0,.08)]",
                          )}
                          style={{ background: s[mode] }}
                        />
                        {s.name}
                      </button>
                    )
                  })}
                </div>
                <div className="mt-1.5 font-mono text-[12px] text-muted-foreground">
                  {(swatchOf(tokens)?.name ?? "Custom") + " · " + tokens[mode].primary}
                </div>
              </div>
              <div>
                <div className="mb-0.5 text-[12.5px] font-medium text-ink2">Contrast checks · WCAG 2.2 AA</div>
                <ul className="m-0 list-none p-0">
                  {shown.map((c) => (
                    <li
                      key={c.label}
                      className="grid grid-cols-[1fr_auto_auto] items-center gap-2.5 border-b border-divider py-2 text-[12.5px]"
                    >
                      <span>
                        {c.label} ({c.min}:1)
                      </span>
                      <span className="font-mono text-[12px] text-muted-foreground tabular">{c.ratio}:1</span>
                      <Pill tone={c.ok ? "green" : "red"}>{c.ok ? "Pass" : "Fail"}</Pill>
                    </li>
                  ))}
                </ul>
              </div>
              {failing.length > 0 && (
                <div role="alert" className="rounded-lg bg-st-red-bg px-3 py-2.5 text-[12.5px] text-st-red">
                  This theme can't be published:{" "}
                  {failing.map((c) => `${c.label.toLowerCase()} is ${c.ratio}:1`).join("; ")}. Try a darker shade, or
                  switch to {mode === "light" ? "dark" : "light"} mode to see that variant.
                </div>
              )}
              {failing.length === 0 && otherFailing.length > 0 && (
                <div role="alert" className="rounded-lg bg-st-red-bg px-3 py-2.5 text-[12.5px] text-st-red">
                  This theme can't be published: the {mode === "light" ? "dark" : "light"} variant fails{" "}
                  {otherFailing.map((c) => c.label.toLowerCase()).join("; ")}. Switch to{" "}
                  {mode === "light" ? "dark" : "light"} mode to see it.
                </div>
              )}
              <div className="border-t border-divider pt-2">
                <FieldLabel>Status colours</FieldLabel>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone="green">Green</Pill>
                  <Pill tone="amber">Amber</Pill>
                  <Pill tone="red">Red</Pill>
                  <Pill tone="grey">Grey</Pill>
                  <TuneStatus tokens={tokens} mode={mode} onChange={change} disabled={!canEdit} />
                </div>
                <Hint className="mt-1.5">
                  Can be tuned, never removed, and must stay distinguishable for colour-blind users.
                </Hint>
              </div>
            </Section>

            <Section title="Type, tone and layout">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <FieldLabel htmlFor="font">Font</FieldLabel>
                  <NativeSelect
                    id="font"
                    label="Font"
                    value={tokens.font}
                    disabled={!canEdit}
                    onChange={(v) => change((t) => ({ ...t, font: v }))}
                    options={q.data.fonts.map((f) => ({ value: f, label: f === "Inter" ? "Inter (default)" : f }))}
                    className="h-8 w-full"
                  />
                  <Hint className="mt-1 text-[11.5px]">Also: IBM Plex Sans, Source Sans 3</Hint>
                </div>
                <div>
                  <FieldLabel>Corner radius</FieldLabel>
                  <ButtonGroup<number>
                    label="Corner radius"
                    value={tokens.radius}
                    disabled={!canEdit}
                    onChange={(v) => change((t) => ({ ...t, radius: v }))}
                    options={[4, 6, 10].map((r) => ({ value: r, label: String(r) }))}
                  />
                </div>
              </div>
              <div>
                <FieldLabel htmlFor="tone">Tone of messages</FieldLabel>
                <NativeSelect
                  id="tone"
                  label="Tone of messages"
                  value={tokens.tone ?? "plain"}
                  disabled={!canEdit}
                  onChange={(v) => change((t) => ({ ...t, tone: v }))}
                  options={TONES}
                  className="h-8 w-full"
                />
                <Hint className="mt-1 text-[11.5px]">
                  Sets the wording style of reminders, alerts and empty states. Edit individual messages under Settings
                  › <a href="/settings/content">Content</a>.
                </Hint>
              </div>
              <div>
                <FieldLabel>Default table density</FieldLabel>
                <ButtonGroup<DraftTokens["density"]>
                  label="Default table density"
                  value={tokens.density}
                  disabled={!canEdit}
                  onChange={(v) => change((t) => ({ ...t, density: v }))}
                  options={[
                    { value: "comfortable", label: "Comfortable" },
                    { value: "compact", label: "Compact" },
                  ]}
                />
              </div>
            </Section>
          </fieldset>

          <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-3">
            <LivePreview tokens={tokens} branding={branding} mode={mode} />
            <History
              data={q.data}
              hasDraft={hasDraft || pending}
              draftName={
                (swatchOf(tokens)?.name ?? "Custom") + " primary · " + (mode === "dark" ? "Dark" : "Light") + " preview"
              }
              canEdit={canEdit}
              busy={busy}
              onRollback={(v) => rollback.mutate(v)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3.5 rounded-[10px] border border-divider bg-surface p-4">
      <h2 className="m-0 text-[14px] font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("m-0 text-[12px] text-muted-foreground", className)}>{children}</p>
}

function LogoSlot({
  label,
  id,
  tone,
  colours,
  onDone,
}: {
  label: string
  id: string | undefined
  tone: "light" | "dark" | "icon"
  colours: Record<string, string>
  onDone: (id: string) => void
}) {
  const input = React.useRef<HTMLInputElement>(null)
  const [busy, setBusy] = React.useState(false)
  const [localUrl, setLocalUrl] = React.useState<string | null>(null)
  const stored = useQuery<{ url: string }, ApiError>({
    queryKey: ["evidence", id],
    queryFn: () => api.get(`/api/evidence/${id}`),
    enabled: !!id && !localUrl,
    staleTime: 4 * 60_000,
  })
  const url = localUrl ?? stored.data?.url ?? null
  const pick = async (f: File) => {
    if (!["image/png", "image/webp", "image/svg+xml"].includes(f.type)) {
      toast.error("Use a PNG, WebP or SVG file.")
      return
    }
    if (f.size > 1024 * 1024) {
      toast.error("That file is over 1 MB. Try a smaller one.")
      return
    }
    setBusy(true)
    try {
      const r = await upload(f, { captured_with: "upload", purpose: "logo", file_name: f.name })
      setLocalUrl(r.thumb_url ?? r.url)
      onDone(r.id)
      toast.success(`${label} uploaded. It's in the draft until you publish.`)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <div className="mb-1.5 text-[12.5px] font-medium text-ink2">{label}</div>
      <button
        type="button"
        aria-label={`Upload ${label.replace(" · ", ", ")}`}
        onClick={() => input.current?.click()}
        className={cn(
          "flex h-14 w-full items-center justify-center rounded-md border border-dashed border-border text-[13px] font-medium text-muted-foreground hover:opacity-90",
        )}
        style={{ background: colours.surface }}
      >
        {busy ? (
          "Uploading…"
        ) : url ? (
          <img src={url} alt="" className="max-h-9 max-w-[80%] object-contain" />
        ) : tone === "icon" ? (
          "Upload"
        ) : (
          <span
            aria-hidden
            className="inline-flex size-[22px] items-center justify-center rounded-md text-[12px] font-bold"
            style={{ background: colours.primary, color: colours.primaryForeground }}
          >
            b
          </span>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/webp,image/svg+xml"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ""
          if (f) void pick(f)
        }}
      />
    </div>
  )
}

function TuneStatus({
  tokens,
  mode,
  onChange,
  disabled,
}: {
  tokens: DraftTokens
  mode: Mode
  onChange: (fn: (t: DraftTokens) => DraftTokens) => void
  disabled: boolean
}) {
  const set = (key: string, v: string) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return
    onChange((t) => ({ ...t, [mode]: { ...t[mode], [key]: v.toUpperCase() } }))
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-[22px] items-center rounded-md border border-border bg-surface px-2 text-[12px] font-medium hover:bg-hover disabled:opacity-40"
        >
          Tune…
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <div className="mb-2 text-[13px] font-semibold">Status colours · {mode === "dark" ? "Dark" : "Light"}</div>
        <p className="m-0 mb-2.5 text-[12px] text-muted-foreground">
          Text colour and its tint. The contrast checks update as you change them.
        </p>
        <div className="flex flex-col gap-2">
          {STATUS_PAIRS.map((p) => (
            <div key={p.key} className="grid grid-cols-[64px_1fr_1fr] items-center gap-2">
              <span
                className="inline-flex h-[22px] items-center justify-center rounded-full text-[12px] font-medium"
                style={{ color: tokens[mode][p.key], background: tokens[mode][`${p.key}Bg`] }}
              >
                {p.label}
              </span>
              {[p.key, `${p.key}Bg`].map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-[12px]">
                  <input
                    type="color"
                    aria-label={`${p.label} ${k.endsWith("Bg") ? "tint" : "text"}`}
                    value={tokens[mode][k] ?? "#000000"}
                    onChange={(e) => set(k, e.target.value)}
                    className="size-6 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <span className="font-mono text-muted-foreground">{tokens[mode][k]}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function LivePreview({ tokens, branding, mode }: { tokens: DraftTokens; branding: Branding; mode: Mode }) {
  const ov = useQuery<Overview, ApiError>({
    queryKey: ["overview", "theme-preview"],
    queryFn: () => api.get<Overview>("/api/overview"),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const logoId = mode === "dark" ? branding.logoDark : branding.logoLight
  const logo = useQuery<{ url: string }, ApiError>({
    queryKey: ["evidence", logoId],
    queryFn: () => api.get(`/api/evidence/${logoId}`),
    enabled: !!logoId,
    staleTime: 4 * 60_000,
  })
  const k = ov.data?.kpis
  const props = (ov.data?.properties ?? []).slice(0, 3)
  const actions = ov.data
    ? ov.data.actions_by_urgency.high + ov.data.actions_by_urgency.med + ov.data.actions_by_urgency.low
    : null
  const compact = tokens.density === "compact"
  return (
    <section aria-label="Live preview" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-[14px] font-semibold">Live preview</h2>
        <span className="text-[12px] text-muted-foreground">Dashboard · {mode === "dark" ? "Dark" : "Light"}</span>
      </div>
      {/* The draft is applied here only, as CSS variables on this container. */}
      <div
        style={previewVars(tokens, mode)}
        className="flex min-h-[420px] overflow-hidden rounded-xl border border-border bg-background text-foreground"
      >
        <div className="flex w-[170px] shrink-0 flex-col gap-1 border-r border-divider bg-sidebar px-2.5 py-3.5 max-sm:hidden">
          <div className="flex items-center gap-2 px-1.5 pt-0.5 pb-2.5">
            {logo.data?.url ? (
              <img src={logo.data.url} alt="" className="size-5 rounded-[5px] object-contain" />
            ) : (
              <span className="inline-flex size-5 items-center justify-center rounded-[5px] bg-primary text-[11px] font-bold text-primary-foreground">
                b
              </span>
            )}
            <span className="truncate text-[13px] font-semibold">{branding.appName || "bide Comply"}</span>
          </div>
          <span className="flex h-7 items-center rounded-md bg-hover px-2 text-[12.5px] font-medium">Overview</span>
          {["Properties", "Actions", "Verification"].map((n) => (
            <span key={n} className="flex h-7 items-center px-2 text-[12.5px] text-muted-foreground">
              {n}
            </span>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-[18px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[17px] font-semibold">Group overview</span>
            <span className="inline-flex h-7 items-center rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground">
              Preview digest
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {[
              ["Class A open", k?.life_safety_open.value],
              ["Urgent over 7 days", k?.high_over_7.value],
              ["Advisories", k?.decisions.advisories],
            ].map(([label, v]) => (
              <div key={String(label)} className="rounded-lg border border-divider bg-surface px-3 py-2.5">
                <div className="text-[11.5px] text-muted-foreground">{label}</div>
                <div className="tabular text-[20px] font-semibold">{v ?? "—"}</div>
              </div>
            ))}
          </div>
          <div className="overflow-hidden rounded-lg border border-divider bg-surface">
            <div className="grid grid-cols-[1fr_90px_80px] border-b border-divider px-3 py-2 text-[11.5px] text-muted-foreground">
              <span>Property</span>
              <span>Score</span>
              <span>Status</span>
            </div>
            {props.map((p, i) => {
              const notReady = p.gate?.status === "not_ready"
              const tone = notReady
                ? "grey"
                : ["red", "amber", "green"].includes(p.score_status)
                  ? p.score_status
                  : "grey"
              const word = notReady ? "Not ready" : tone === "grey" ? "No score" : tone[0].toUpperCase() + tone.slice(1)
              return (
                <div
                  key={p.id}
                  className={cn(
                    "grid grid-cols-[1fr_90px_80px] items-center px-3 text-[12.5px]",
                    compact ? "py-1.5" : "py-2.5",
                    i < props.length - 1 && "border-b border-divider",
                  )}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="tabular">{notReady ? "Gate" : p.score != null ? `${p.score}%` : "—"}</span>
                  <span
                    className={cn(
                      "inline-flex h-[22px] w-fit items-center rounded-full px-2 text-[12px] font-medium",
                      tone === "red" && "bg-st-red-bg text-st-red",
                      tone === "amber" && "bg-st-amber-bg text-st-amber",
                      tone === "green" && "bg-st-green-bg text-st-green",
                      tone === "grey" && "bg-st-grey-bg text-st-grey",
                    )}
                  >
                    {word}
                  </span>
                </div>
              )
            })}
            {!ov.data && (
              <div className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">
                {ov.isError ? "Sample numbers aren't available for your role." : "Loading…"}
              </div>
            )}
          </div>
          <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-link">
            View all {actions ?? ""} Actions <ArrowRight aria-hidden className="size-3.5" />
          </span>
        </div>
      </div>
    </section>
  )
}

function History({
  data,
  hasDraft,
  draftName,
  canEdit,
  busy,
  onRollback,
}: {
  data: AppearanceData
  hasDraft: boolean
  draftName: string
  canEdit: boolean
  busy: boolean
  onRollback: (v: number) => void
}) {
  const rows: (ThemeVersion | null)[] = [...(hasDraft ? [null] : []), ...data.history]
  return (
    <section aria-label="Version history" className="overflow-hidden rounded-[10px] border border-divider bg-surface">
      <h2 className="m-0 border-b border-divider px-4 py-3 text-[14px] font-semibold">Version history</h2>
      <ul className="m-0 list-none p-0">
        {rows.map((v) =>
          v === null ? (
            <li
              key="draft"
              className="grid grid-cols-[70px_1fr_auto] items-center gap-2.5 border-b border-divider px-4 py-2.5"
            >
              <Pill tone="amber">Draft</Pill>
              <span className="min-w-0 truncate">{draftName}</span>
              <span className="text-[12px] text-muted-foreground">Not published</span>
            </li>
          ) : (
            <li
              key={v.id}
              className="grid grid-cols-[70px_1fr_auto] items-center gap-2.5 border-b border-divider px-4 py-2.5"
            >
              {v.status === "live" ? <Pill tone="green">Live</Pill> : <Pill tone="grey">v{v.version}</Pill>}
              <span className="min-w-0 truncate">
                v{v.version} · {v.name}
              </span>
              <span className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
                {v.version === 1 && !v.by
                  ? "At launch"
                  : `${v.by ?? "Someone"} · ${v.published_at ? fmtDate(v.published_at) : ""}`}
                {v.status === "live" ? (
                  <CheckIcon aria-label="In use" className="size-3.5 text-st-green" />
                ) : (
                  canEdit && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onRollback(v.version)}
                      className="inline-flex h-7 items-center rounded-md border border-border bg-surface px-2.5 text-[12.5px] font-medium text-foreground hover:bg-hover disabled:opacity-40"
                    >
                      Roll back
                    </button>
                  )
                )}
              </span>
            </li>
          ),
        )}
      </ul>
      <p className="m-0 px-4 py-2.5 text-[12px] text-muted-foreground">
        Every published theme is kept. Rolling back is one click and is logged in the audit trail.
      </p>
    </section>
  )
}
