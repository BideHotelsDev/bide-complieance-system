import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import * as React from "react"

import { LoadingPage } from "@bide-comply/ui/components/page"
import { Sheet, SheetContent, SheetTitle } from "@bide-comply/ui/components/sheet"

import { useMe } from "@/lib/session"
import { CommandPalette } from "./CommandPalette"
import { PhoneMenuProvider, PhoneTabBar, PhoneTopBar } from "./PhoneNav"
import { PrivacyNotice } from "./PrivacyNotice"
import { Sidebar } from "./Sidebar"

export function AppShell() {
  const me = useMe()
  const navigate = useNavigate()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const [search, setSearch] = React.useState(false)
  // The phone menu remembers the page it was opened on, so it closes itself when the page changes.
  const [menuAt, setMenuAt] = React.useState<string | null>(null)
  const menu = menuAt === path
  // The form builder and Import take the whole screen and have their own way back (design: TemplateEditor, Import).
  const focus = /^\/settings\/(library\/[^/]+|import)$/.test(path)
  const openMenu = React.useCallback(() => setMenuAt(path), [path])
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
    <PhoneMenuProvider value={openMenu}>
      <div className="flex min-h-screen bg-background">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:p-2"
        >
          Skip to content
        </a>
        <div className={focus ? "hidden" : "hidden md:block"}>
          <Sidebar onSearch={() => setSearch(true)} collapsed={collapsed} onToggle={toggle} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Phone Home draws its own header (design: Manager on phone), with the menu button in it. */}
          {path !== "/" && !focus && <PhoneTopBar onSearch={() => setSearch(true)} />}
          <main id="main" className="min-w-0 flex-1 px-4 pt-5 pb-24 md:px-7 md:py-6">
            <Outlet />
          </main>
        </div>
        {!focus && <PhoneTabBar />}
        <Sheet open={menu} onOpenChange={(o) => setMenuAt(o ? path : null)}>
          <SheetContent side="left" className="w-[280px] gap-0 p-0 md:hidden">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <Sidebar
              inSheet
              onSearch={() => {
                setMenuAt(null)
                setSearch(true)
              }}
              collapsed={false}
              onToggle={() => setMenuAt(null)}
            />
          </SheetContent>
        </Sheet>
        <CommandPalette open={search} onOpenChange={setSearch} />
        {!me.data.privacy_notice_seen && <PrivacyNotice />}
      </div>
    </PhoneMenuProvider>
  )
}
