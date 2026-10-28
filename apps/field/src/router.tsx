import { basepath } from "@/lib/base"
import { createRootRoute, createRoute, createRouter, Navigate, Outlet } from "@tanstack/react-router"

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
  if (me.isPending) return <Page />
  if (me.error?.status === 401) return <Navigate to="/signin" />
  if (me.error)
    return (
      <Page className="justify-center px-4">
        <ErrorBox message={me.error.message} onRetry={() => void me.refetch()} />
      </Page>
    )
  return <Outlet />
}

const root = createRootRoute({ component: Outlet })
const authed = createRoute({ getParentRoute: () => root, id: "authed", component: Authed })

const routes = [
  createRoute({ getParentRoute: () => root, path: "/signin", component: SignInPage }),
  createRoute({ getParentRoute: () => root, path: "/signin/code", component: () => <CodePage stage="code" /> }),
  createRoute({ getParentRoute: () => root, path: "/signin/totp", component: () => <CodePage stage="totp" /> }),
  createRoute({
    getParentRoute: () => root,
    path: "/signin/totp-setup",
    component: () => <CodePage stage="totp-setup" />,
  }),
  createRoute({ getParentRoute: () => root, path: "/contractor", component: ContractorPortalPage }),
  authed.addChildren([
    createRoute({ getParentRoute: () => authed, path: "/", component: TodayPage }),
    createRoute({ getParentRoute: () => authed, path: "/task/$taskId", component: TaskPage }),
    createRoute({ getParentRoute: () => authed, path: "/report", component: ReportPage }),
    createRoute({ getParentRoute: () => authed, path: "/contractor-visit", component: ContractorVisitPage }),
    createRoute({ getParentRoute: () => authed, path: "/history", component: HistoryPage }),
    createRoute({ getParentRoute: () => authed, path: "/documents", component: DocumentsPage }),
    createRoute({ getParentRoute: () => authed, path: "/me", component: MePage }),
  ]),
]

export const router = createRouter({ routeTree: root.addChildren(routes), defaultPreload: "intent", basepath })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
