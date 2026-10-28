/*
 * Every screen in the management portal and the admin CMS (design: Site map and key flows). Plain names are the
 * words people see in the menu.
 */
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router"

import { AppShell } from "./components/AppShell"
import { ActionsPage } from "./pages/Actions"
import { ApprovalsPage } from "./pages/Approvals"
import { AssessorPage } from "./pages/Assessor"
import { CertificatesPage } from "./pages/Certificates"
import { GatePage } from "./pages/Gate"
import { GatesPage } from "./pages/Gates"
import { HelpPage } from "./pages/Help"
import { HomePage } from "./pages/Home"
import { MePage } from "./pages/Me"
import { MyTodoPage } from "./pages/MyTodo"
import { PropertiesPage } from "./pages/Properties"
import { PropertyPage } from "./pages/Property"
import { ReportsPage } from "./pages/Reports"
import { ReviewsPage } from "./pages/Reviews"
import { ScorecardPage } from "./pages/Scorecard"
import { AlertsPage } from "./pages/settings/Alerts"
import { AppearancePage } from "./pages/settings/Appearance"
import { AuditLogPage } from "./pages/settings/AuditLog"
import { ContentPage } from "./pages/settings/Content"
import { ImportPage } from "./pages/settings/Import"
import { LibraryPage } from "./pages/settings/Library"
import { PeoplePage } from "./pages/settings/People"
import { PropertyDetailsPage, PropertyListAdmin } from "./pages/settings/PropertyDetails"
import { SetupPage } from "./pages/settings/Setup"
import { TemplateEditorPage } from "./pages/settings/TemplateEditor"
import { SignoffsPage } from "./pages/Signoffs"
import { CodePage, SignInPage } from "./pages/SignIn"

// Search params are free-form strings; each page reads what it needs with useParams().
const loose = (s: Record<string, unknown>) => s

const root = createRootRoute({ component: Outlet })
const shell = createRoute({ getParentRoute: () => root, id: "shell", component: AppShell })

const r = (path: string, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => shell, path, component, validateSearch: loose })

const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: "/signin", component: SignInPage, validateSearch: loose }),
  createRoute({ getParentRoute: () => root, path: "/signin/code", component: () => <CodePage stage="code" /> }),
  createRoute({ getParentRoute: () => root, path: "/signin/totp", component: () => <CodePage stage="totp" /> }),
  createRoute({ getParentRoute: () => root, path: "/signin/totp-setup", component: () => <CodePage stage="totp-setup" /> }),
  shell.addChildren([
    r("/", HomePage),
    r("/todo", MyTodoPage),
    r("/properties", PropertiesPage),
    r("/properties/$code", PropertyPage),
    r("/certificates", CertificatesPage),
    r("/actions", ActionsPage),
    r("/reviews", ReviewsPage),
    r("/gates", GatesPage),
    r("/gates/$code", GatePage),
    r("/signoffs", SignoffsPage),
    r("/approvals", ApprovalsPage),
    r("/scorecard", ScorecardPage),
    r("/reports", ReportsPage),
    r("/assessor/$code", AssessorPage),
    r("/help", HelpPage),
    r("/me", MePage),
    r("/settings", LibraryPage),
    r("/settings/library", LibraryPage),
    r("/settings/library/$id", TemplateEditorPage),
    r("/settings/setup", SetupPage),
    r("/settings/setup/$code", SetupPage),
    r("/settings/people", PeoplePage),
    r("/settings/properties", PropertyListAdmin),
    r("/settings/properties/$code", PropertyDetailsPage),
    r("/settings/alerts", AlertsPage),
    r("/settings/content", ContentPage),
    r("/settings/import", ImportPage),
    r("/settings/appearance", AppearancePage),
    r("/settings/audit", AuditLogPage),
  ]),
])

export const router = createRouter({ routeTree, defaultPreload: "intent", scrollRestoration: true })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
