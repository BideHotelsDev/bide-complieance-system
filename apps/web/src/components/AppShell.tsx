import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import * as React from "react"

import { LoadingPage } from "@bide-comply/ui/components/page"

import { useMe } from "@/lib/session"
import { CommandPalette } from "./CommandPalette"
import { PrivacyNotice } from "./PrivacyNotice"
import { Sidebar } from "./Sidebar"

export function AppShell() {
  const me = useMe()
  const navigate = useNavigate()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const [search, setSearch] = React.useState(false)
  const [collapsed, setCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem("bc-sidebar") === "collapsed"
    } catch {
      return false
    }
  })
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setSearch((s) => !s)
      }
    }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [])
  React.useEffect(() => {
    if (me.error?.status === 401) void navigate({ to: "/signin", search: { next: path } })
  }, [me.error, navigate, path])
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem("bc-sidebar", c ? "open" : "collapsed")
      } catch {
        /* ignore */
      }
      return !c
    })
  if (!me.data)
    return (
      <div className="p-8">
        <LoadingPage />
      </div>
    )
  return (
    <div className="flex min-h-screen bg-background">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:p-2">
        Skip to content
      </a>
      <div className="hidden md:block">
        <Sidebar onSearch={() => setSearch(true)} collapsed={collapsed} onToggle={toggle} />
      </div>
      <main id="main" className="min-w-0 flex-1 px-4 py-5 md:px-7 md:py-6">
        <Outlet />
      </main>
      <CommandPalette open={search} onOpenChange={setSearch} />
      {!me.data.privacy_notice_seen && <PrivacyNotice />}
    </div>
  )
}
