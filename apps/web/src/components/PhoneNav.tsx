/*
 * Phone navigation (design: Manager on phone). Below 768px the sidebar gives way to a bottom app bar (Home, To-do,
 * Actions, Me) and a slim top bar whose menu button opens the full sidebar in a sheet, so every page stays reachable.
 */
import { Link, useRouterState } from "@tanstack/react-router"
import { Menu, Search } from "lucide-react"
import * as React from "react"

import { Mark } from "@bide-comply/ui/components/page"
import { useBranding } from "@bide-comply/ui/lib/theme"
import { cn } from "@bide-comply/ui/lib/utils"

import { navFor, useMe } from "@/lib/session"

const MenuContext = React.createContext<() => void>(() => {})

export const PhoneMenuProvider = MenuContext.Provider

/** The button that opens the full menu sheet on phones. */
export function PhoneMenuButton({ className }: { className?: string }) {
  const open = React.useContext(MenuContext)
  return (
    <button
      type="button"
      onClick={open}
      aria-label="Open menu"
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground hover:bg-hover",
        className,
      )}
    >
      <Menu aria-hidden className="size-[22px]" />
    </button>
  )
}

export function PhoneTopBar({ onSearch }: { onSearch: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-divider bg-surface pr-1.5 pl-4 md:hidden">
      <Link to="/" className="flex min-w-0 flex-1 items-center gap-2 text-foreground no-underline">
        <Mark size={22} />
        <span className="truncate text-[15px] font-semibold">
          <AppName />
        </span>
      </Link>
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search"
        className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-hover"
      >
        <Search aria-hidden className="size-5" />
      </button>
      <PhoneMenuButton />
    </header>
  )
}

const ICON = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 }

function HomeIcon() {
  return (
    <svg {...ICON} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 11l8-7 8 7v9H4z" />
    </svg>
  )
}
function TodoIcon() {
  return (
    <svg {...ICON} strokeLinecap="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  )
}
function ActionsIcon() {
  return (
    <svg {...ICON} strokeLinecap="round" aria-hidden>
      <path d="M12 3l9.5 17h-19z" />
    </svg>
  )
}
function SignIcon() {
  return (
    <svg {...ICON} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </svg>
  )
}
function MeIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  )
}

type Tab = { to: string; label: string; icon: () => React.ReactElement; match: string[] }

export function PhoneTabBar() {
  const me = useMe().data
  const path = useRouterState({ select: (s) => s.location.pathname })
  if (!me) return null
  const show = navFor(me)
  const tabs: Tab[] = [{ to: "/", label: "Home", icon: HomeIcon, match: [] }]
  if (show.todo) tabs.push({ to: "/todo", label: "To-do", icon: TodoIcon, match: ["/todo", "/approvals"] })
  if (show.actions) tabs.push({ to: "/actions", label: "Actions", icon: ActionsIcon, match: ["/actions"] })
  // Dutyholders have no to-do or actions list: their everyday page is Sign-offs.
  if (!show.todo && show.signoffs)
    tabs.push({ to: "/signoffs", label: "Sign-offs", icon: SignIcon, match: ["/signoffs"] })
  tabs.push({ to: "/me", label: "Me", icon: MeIcon, match: ["/me"] })
  const active = (t: Tab) => (t.to === "/" ? path === "/" : t.match.some((m) => path === m || path.startsWith(`${m}/`)))
  return (
    <nav
      aria-label="App"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-divider bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {tabs.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          aria-current={active(t) ? "page" : undefined}
          className={cn(
            "flex h-16 flex-1 flex-col items-center gap-0.5 pt-2 text-[11px] no-underline",
            active(t) ? "font-semibold text-foreground" : "text-muted-foreground",
          )}
        >
          <t.icon />
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

function AppName() {
  return <>{useBranding().appName}</>
}
