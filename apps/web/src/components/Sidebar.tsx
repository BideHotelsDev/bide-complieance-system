/*
 * The sidebar (design: Navigation). Fewer items, everyday words, bigger click targets. Badges only where you are
 * needed: red = needs you now, blue = waiting for your review, amber = waiting for your signature, grey = a count.
 * Collapsed, it becomes an icon rail with a tooltip giving the name, the count and one line on what the page is for.
 */
import { Link, useRouterState } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  BarChart3,
  Building2,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  CircleHelp,
  ClipboardCheck,
  FileText,
  Flag,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react"
import * as React from "react"

import { api } from "@bide-comply/api-client"
import { Avatar, Mark } from "@bide-comply/ui/components/page"
import { useBranding } from "@bide-comply/ui/lib/theme"
import { cn } from "@bide-comply/ui/lib/utils"

import { useProperty } from "@/lib/property"
import { navFor, useMe } from "@/lib/session"
import { PropertySwitcher } from "./PropertySwitcher"

type Nav = { todo: number; actions: number; reviews: number; signoffs: number }

type Item = {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  tip: string
  count?: number
  tone?: "red" | "blue" | "amber" | "grey"
  show: boolean
  match?: string[]
}

export const SETTINGS_ITEMS = [
  { to: "/settings/library", label: "Compliance library", tip: "All checks and the questions staff answer" },
  { to: "/settings/setup", label: "Property setup", tip: "Choose which checks apply and who does them" },
  { to: "/settings/properties", label: "Property details", tip: "Features, geofence, licences and locations" },
  { to: "/settings/people", label: "People and roles", tip: "Who can do what, and where" },
  { to: "/settings/alerts", label: "Alert rules", tip: "Who gets told, and when, if something slips" },
  { to: "/settings/content", label: "Messages and wording", tip: "Edit reminders, alerts and on-screen words" },
  { to: "/settings/import", label: "Import data", tip: "Bring in the register Sheet or the gate workbook" },
  { to: "/settings/appearance", label: "Appearance", tip: "Theme, logo and font" },
  { to: "/settings/audit", label: "Audit log", tip: "Every change, in order. Read only." },
]

export function Sidebar({
  onSearch,
  collapsed,
  onToggle,
  inSheet = false,
}: {
  onSearch: () => void
  collapsed: boolean
  onToggle: () => void
  /** Shown in the phone menu sheet: fills the sheet, and the sheet's own close button replaces collapse. */
  inSheet?: boolean
}) {
  const me = useMe().data
  const { propertyId } = useProperty()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const counts = useQuery({
    queryKey: ["nav", propertyId],
    queryFn: () => api.get<Nav>("/api/nav", { property: propertyId }),
    refetchInterval: 60_000,
    enabled: !!me,
  }).data
  const [tour, setTour] = React.useState(() => {
    try {
      return localStorage.getItem("bc-tour") !== "done"
    } catch {
      return false
    }
  })
  // Opening Help marks the tour done (Help sets the flag); re-read it on every page change.
  React.useEffect(() => {
    try {
      if (localStorage.getItem("bc-tour") === "done") setTour(false)
    } catch {
      /* ignore */
    }
  }, [path])
  const [settingsOpen, setSettingsOpen] = React.useState(path.startsWith("/settings"))
  if (!me) return null
  const show = navFor(me)
  const items: Item[] = [
    {
      to: "/",
      label: "Home",
      icon: LayoutGrid,
      tip: "See where every property stands in ten seconds",
      show: show.home,
    },
    {
      to: "/todo",
      label: "My to-do",
      icon: CircleCheck,
      count: counts?.todo,
      tone: "red",
      show: show.todo,
      tip: "Everything waiting for you: checks, actions, reviews, signatures",
      match: ["/todo", "/approvals"],
    },
  ]
  const compliance: Item[] = [
    {
      to: "/properties",
      label: "Properties",
      icon: Building2,
      tip: "Pick a property to see its checks, fixes and certificates",
      show: show.properties,
      match: ["/properties", "/certificates"],
    },
    {
      to: "/actions",
      label: "Actions to fix",
      icon: Flag,
      count: counts?.actions,
      tone: "grey",
      show: show.actions,
      tip: "Problems found and who is fixing them",
    },
    {
      to: "/reviews",
      label: "Evidence review",
      icon: ShieldCheck,
      count: counts?.reviews,
      tone: "blue",
      show: show.reviews,
      tip: "Check the photos and certificates staff sent in",
    },
    {
      to: "/gates",
      label: "Opening checklists",
      icon: ClipboardCheck,
      show: show.gates,
      tip: "Everything that must be done before guests stay",
      match: ["/gates", "/assessor"],
    },
    {
      to: "/signoffs",
      label: "Sign-offs",
      icon: PenLine,
      count: counts?.signoffs,
      tone: "amber",
      show: show.signoffs,
      tip: "Things waiting for a signature or an approval",
    },
    {
      to: "/scorecard",
      label: "Team scorecard",
      icon: BarChart3,
      show: show.scorecard,
      tip: "Weekly goals and the site league",
    },
    {
      to: "/reports",
      label: "Reports and packs",
      icon: FileText,
      show: show.reports,
      tip: "Make a pack for an inspector or insurer",
    },
  ]
  const active = (it: Item) =>
    it.to === "/" ? path === "/" : (it.match ?? [it.to]).some((m) => path === m || path.startsWith(`${m}/`))

  const badge = (it: Item) =>
    it.count ? (
      collapsed ? (
        <span
          aria-hidden
          className={cn(
            "absolute top-1.5 right-1.5 size-2 rounded-full border-2 border-sidebar",
            it.tone === "red" && "bg-st-red",
            it.tone === "blue" && "bg-st-blue",
            it.tone === "amber" && "bg-[#C77612]",
            it.tone === "grey" && "bg-subtle",
          )}
        />
      ) : (
        <span
          aria-label={`${it.count} ${it.tone === "red" ? "need you" : it.tone === "blue" ? "waiting" : it.tone === "amber" ? "awaiting signature" : "open"}`}
          className={cn(
            "tabular ml-auto inline-flex h-5 min-w-[22px] items-center justify-center rounded-full px-1.5 text-xs font-semibold",
            it.tone === "red" && "bg-st-red text-white",
            it.tone === "blue" && "bg-st-blue text-white dark:text-black",
            it.tone === "amber" && "bg-st-amber-bg text-st-amber",
            it.tone === "grey" && "bg-border text-ink2",
          )}
        >
          {it.count}
        </span>
      )
    ) : null

  const link = (it: Item) =>
    it.show && (
      <Link
        key={it.to}
        to={it.to}
        aria-current={active(it) ? "page" : undefined}
        title={collapsed ? `${it.label}${it.count ? ` · ${it.count}` : ""}\n${it.tip}` : it.tip}
        className={cn(
          "relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium text-ink2 no-underline hover:bg-hover",
          collapsed && "w-11 justify-center px-0",
          active(it) &&
            "bg-surface text-foreground shadow-[0_0_0_1px_var(--c-border),0_1px_2px_rgba(17,17,19,.05)] hover:bg-surface",
        )}
      >
        <it.icon className={cn("size-[18px] shrink-0", active(it) ? "text-foreground" : "text-muted-foreground")} />
        {!collapsed && <span className="truncate">{it.label}</span>}
        {badge(it)}
      </Link>
    )

  return (
    <nav
      aria-label="Main"
      className={cn(
        "flex shrink-0 flex-col gap-0.5 overflow-y-auto bg-sidebar py-3.5",
        inSheet ? "h-full w-full" : "sticky top-0 h-screen border-r border-divider",
        collapsed ? "w-16 items-center px-2.5" : inSheet ? "px-3" : "w-[264px] px-3",
      )}
    >
      <div className={cn("flex items-center gap-2 pb-3", collapsed ? "justify-center" : "px-1")}>
        <Mark size={collapsed ? 28 : 24} />
        {!collapsed && (
          <span className="text-[15px] font-semibold">
            <AppName />
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "rounded-md p-1 text-muted-foreground hover:bg-hover",
            collapsed || inSheet ? "hidden" : "ml-auto",
          )}
        >
          <PanelLeftClose className="size-4" />
        </button>
      </div>
      {collapsed ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand sidebar"
          className="mb-1 rounded-md p-2 hover:bg-hover"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      ) : (
        <>
          <PropertySwitcher />
          <button
            type="button"
            onClick={onSearch}
            className="my-2 mb-1 flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-[14px] text-muted-foreground"
          >
            <Search className="size-4" />
            Search anything
            <kbd className="ml-auto rounded border border-border px-1.5 font-sans text-[11.5px]">⌘K</kbd>
          </button>
        </>
      )}
      {items.map(link)}
      {!collapsed && compliance.some((i) => i.show) && (
        <div className="px-2.5 pt-4 pb-1.5 text-xs font-medium text-subtle">Compliance</div>
      )}
      {compliance.map(link)}
      {show.settings && (
        <>
          {!collapsed && <div className="px-2.5 pt-4 pb-1.5 text-xs font-medium text-subtle">Admin</div>}
          <button
            type="button"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((o) => !o)}
            title="Settings: library, property setup, people, alert rules, import and appearance"
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium text-ink2 hover:bg-hover",
              collapsed && "w-11 justify-center px-0",
              path.startsWith("/settings") && !settingsOpen && "bg-surface shadow-[0_0_0_1px_var(--c-border)]",
            )}
          >
            <SlidersHorizontal className="size-[18px] text-muted-foreground" />
            {!collapsed && (
              <>
                Settings
                <ChevronRight className={cn("ml-auto size-3.5 transition-transform", settingsOpen && "rotate-90")} />
              </>
            )}
          </button>
          {settingsOpen && !collapsed && (
            <div className="ml-[22px] flex flex-col border-l border-border pl-2">
              {SETTINGS_ITEMS.map((s) => (
                <Link
                  key={s.to}
                  to={s.to}
                  title={s.tip}
                  aria-current={path.startsWith(s.to) ? "page" : undefined}
                  className={cn(
                    "flex h-8 items-center rounded-md px-2 text-[13.5px] text-ink2 no-underline hover:bg-hover",
                    path.startsWith(s.to) &&
                      "bg-surface font-medium text-foreground shadow-[0_0_0_1px_var(--c-border)]",
                  )}
                >
                  {s.label}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
      <div className="mt-auto" />
      {tour && !collapsed && (
        <div className="mx-0 my-3 flex flex-col gap-1.5 rounded-[10px] border border-border bg-surface p-3">
          <span className="text-[13px] font-semibold">New to bide Comply?</span>
          <span className="text-[12.5px] text-muted-foreground">
            A 2-minute tour of where things are and what the colours mean.
          </span>
          <span className="flex gap-1.5">
            <Link
              to="/help"
              className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-foreground no-underline"
            >
              Start tour
            </Link>
            <button
              type="button"
              className="h-7 rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-hover"
              onClick={() => {
                setTour(false)
                try {
                  localStorage.setItem("bc-tour", "done")
                } catch {
                  /* ignore */
                }
              }}
            >
              Not now
            </button>
          </span>
        </div>
      )}
      <Link
        to="/help"
        title="Help and guides"
        className={cn(
          "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium text-ink2 no-underline hover:bg-hover",
          collapsed && "w-11 justify-center px-0",
        )}
      >
        <CircleHelp className="size-[18px] text-muted-foreground" />
        {!collapsed && "Help and guides"}
      </Link>
      <Link
        to="/me"
        className={cn(
          "mt-1.5 flex items-center gap-2.5 border-t border-divider px-1.5 pt-3 pb-0.5 text-foreground no-underline",
          collapsed && "justify-center px-0",
        )}
      >
        <Avatar initials={me.initials} />
        {!collapsed && (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[13.5px] font-semibold">{me.name}</span>
            <span className="truncate text-xs text-muted-foreground">{me.title}</span>
          </span>
        )}
        {!collapsed && <ChevronsUpDown className="ml-auto size-4 text-subtle" />}
      </Link>
    </nav>
  )
}

function AppName() {
  return <>{useBranding().appName}</>
}
