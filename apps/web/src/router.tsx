/*
 * Every screen in the management portal and the admin CMS (design: Site map and key flows). Plain names are the
 * words people see in the menu.
 */
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router"
import { PageTitle } from "@bide-comply/ui/components/page-title"

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
import { NotFoundPage } from "./pages/NotFound"
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
import { AdminSignInPage, CodePage, SignInPage } from "./pages/SignIn"

// Search params are free-form strings; each page reads what it needs with useParams().
const loose = (s: Record<string, unknown>) => s

const root = createRootRoute({ component: Outlet })
const shell = createRoute({ getParentRoute: () => root, id: "shell", component: AppShell })

// Each screen names the browser tab, e.g. "People and roles · bide Comply" (UX audit F9).
const titled = (title: string, Component: () => React.ReactNode) =>
  function Titled() {
    return (
      <>
        <PageTitle title={title} />
        <Component />
      </>
    )
  }

const r = (path: string, component: () => React.ReactNode, title: string) =>
  createRoute({ getParentRoute: () => shell, path, component: titled(title, component), validateSearch: loose })

const routeTree = root.addChildren([
  createRoute({
    getParentRoute: () => root,
    path: "/signin",
    component: titled("Sign in", SignInPage),
    validateSearch: loose,
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/admin-signin",
    component: titled("Admin sign-in", AdminSignInPage),
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/signin/code",
    component: titled("Enter your code", () => <CodePage stage="code" />),
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
  shell.addChildren([
    r("/", HomePage, "Home"),
    r("/todo", MyTodoPage, "My to-do"),
    r("/properties", PropertiesPage, "Properties"),
    r("/properties/$code", PropertyPage, "Property"),
    r("/certificates", CertificatesPage, "Certificates"),
    r("/actions", ActionsPage, "Actions to fix"),
    r("/reviews", ReviewsPage, "Evidence review"),
    r("/gates", GatesPage, "Opening checklists"),
    r("/gates/$code", GatePage, "Opening checklist"),
    r("/signoffs", SignoffsPage, "Sign-offs"),
    r("/approvals", ApprovalsPage, "Approvals"),
    r("/scorecard", ScorecardPage, "Team scorecard"),
    r("/reports", ReportsPage, "Reports and packs"),
    r("/assessor/$code", AssessorPage, "Audit walk"),
    r("/help", HelpPage, "Help"),
    r("/me", MePage, "Your account"),
    r("/settings", LibraryPage, "Compliance library"),
    r("/settings/library", LibraryPage, "Compliance library"),
    r("/settings/library/$id", TemplateEditorPage, "Edit template"),
    r("/settings/setup", SetupPage, "Property setup"),
    r("/settings/setup/$code", SetupPage, "Property setup"),
    r("/settings/people", PeoplePage, "People and roles"),
    r("/settings/properties", PropertyListAdmin, "Property details"),
    r("/settings/properties/$code", PropertyDetailsPage, "Property details"),
    r("/settings/alerts", AlertsPage, "Alert rules"),
    r("/settings/content", ContentPage, "Messages and wording"),
    r("/settings/import", ImportPage, "Import data"),
    r("/settings/appearance", AppearancePage, "Appearance"),
    r("/settings/audit", AuditLogPage, "Audit log"),
    // Anything else: a not-found page inside the shell, so the menu and a way back are still there.
    r("$", () => <NotFoundPage />, "Page not found"),
  ]),
])

export const router = createRouter({ routeTree, defaultPreload: "intent", scrollRestoration: true })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
