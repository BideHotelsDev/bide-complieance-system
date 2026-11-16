import { basepath } from "@/lib/base"
import { createRootRoute, createRoute, createRouter, Navigate, Outlet, useLocation } from "@tanstack/react-router"

import { PageTitle } from "@bide-comply/ui/components/page-title"

import { ErrorBox, Page } from "./components/kit"
import { ContractorPortalPage } from "./pages/ContractorPortal"
import { ContractorVisitPage } from "./pages/ContractorVisit"
import { DocumentsPage } from "./pages/Documents"
import { HistoryPage } from "./pages/History"
import { MePage } from "./pages/Me"
import { ReportPage } from "./pages/Report"
import { CodePage, SignInPage } from "./pages/SignIn"
import { TaskPage } from "./pages/Task"
import { TodayPage } from "./pages/Today"
import { useMe } from "./lib/session"

/* Everything except sign-in needs a person. Offline, the last known person (cached) keeps the app usable. */
function Authed() {
  const me = useMe()
  const path = useLocation({ select: (l) => l.pathname })
  if (me.isPending) return <Page />
  if (me.error?.status === 401) return <Navigate to="/signin" />
  if (me.error)
    return (
      <Page className="justify-center px-4">
        <ErrorBox message={me.error.message} onRetry={() => void me.refetch()} />
      </Page>
    )
  // Contractors (magic link, no staff role) only have the contractor portal.
  if (me.data.roles.length > 0 && me.data.roles.every((r) => r === "contractor") && path !== "/contractor")
    return <Navigate to="/contractor" />
  return <Outlet />
}

// Each screen names the browser tab, e.g. "History · bide Comply" (UX audit F9).
const titled = (title: string, Component: () => React.ReactNode) =>
  function Titled() {
    return (
      <>
        <PageTitle title={title} />
        <Component />
      </>
    )
  }

const root = createRootRoute({ component: Outlet })
const authed = createRoute({ getParentRoute: () => root, id: "authed", component: Authed })

const routes = [
  createRoute({ getParentRoute: () => root, path: "/signin", component: titled("Sign in", SignInPage) }),
  createRoute({
    getParentRoute: () => root,
    path: "/signin/code",
    component: titled("Check your email", () => <CodePage stage="code" />),
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/signin/totp",
    component: titled("Confirm it's you", () => <CodePage stage="totp" />),
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/signin/totp-setup",
    component: titled("Set up your authenticator app", () => <CodePage stage="totp-setup" />),
  }),
  authed.addChildren([
    createRoute({
      getParentRoute: () => authed,
      path: "/contractor",
      component: titled("Contractor portal", ContractorPortalPage),
    }),
    createRoute({ getParentRoute: () => authed, path: "/", component: titled("Today", TodayPage) }),
    createRoute({ getParentRoute: () => authed, path: "/task/$taskId", component: titled("Check", TaskPage) }),
    createRoute({ getParentRoute: () => authed, path: "/report", component: titled("Report a problem", ReportPage) }),
    createRoute({
      getParentRoute: () => authed,
      path: "/contractor-visit",
      component: titled("Contractor visit", ContractorVisitPage),
    }),
    createRoute({ getParentRoute: () => authed, path: "/history", component: titled("History", HistoryPage) }),
    createRoute({ getParentRoute: () => authed, path: "/documents", component: titled("My documents", DocumentsPage) }),
    createRoute({ getParentRoute: () => authed, path: "/me", component: titled("Me", MePage) }),
    // An old or mistyped link lands on Today (or the contractor screen) instead of a bare "Not Found".
    createRoute({ getParentRoute: () => authed, path: "$", component: () => <Navigate to="/" /> }),
  ]),
]

export const router = createRouter({ routeTree: root.addChildren(routes), defaultPreload: "intent", basepath })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
