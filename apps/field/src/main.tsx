import { appPath } from "@/lib/base"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import * as React from "react"
import { createRoot } from "react-dom/client"

import { api, ApiError, configure } from "@bide-comply/api-client"
import { Toaster } from "@bide-comply/ui/components/toaster"
import { loadTheme, type Theme } from "@bide-comply/ui/lib/theme"

import "./index.css"
import { toastSent } from "./components/sync"
import { refreshPush } from "./lib/push"
import { pruneDrafts } from "./lib/drafts"
import { onSent, startSync } from "./lib/queue"
import { PropertyProvider } from "./lib/session"
import type { SubmitResult } from "./lib/types"
import { router } from "./router"

// Theme first, so the first paint already has the published colours (CMS-13).
void loadTheme(() => api.get<Theme>("/api/theme"))

configure({
  app: "field",
  onSignedOut: () => {
    if (!location.pathname.startsWith(appPath("/signin"))) location.href = appPath("/signin")
  },
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Offline is handled by the cached copy; don't keep hammering a dead connection.
      retry: (n, e) => !(e instanceof ApiError && [0, 401, 403, 404].includes(e.status)) && n < 2,
      networkMode: "always",
    },
    mutations: { networkMode: "always" },
  },
})

// Checks saved on the phone send by themselves when the signal comes back.
startSync()
void pruneDrafts()
onSent((item, res) => {
  if (item.kind === "post") {
    // A report or visit saved offline: the server's own words (who has been told, Actions raised).
    const n = "actions" in res ? (res.actions?.length ?? 0) : 0
    toastSent(
      "message" in res && res.message
        ? `${item.title}: ${res.message}`
        : `${item.title} saved.${n ? ` ${n} Action${n === 1 ? "" : "s"} raised.` : " Thank you."}`,
    )
  } else {
    // A check saved offline that turns out Failed still says what happened next (design: AppResult, in short).
    const r = res as SubmitResult
    toastSent(
      r.result === "failed" && r.action
        ? `${item.title} sent. Logged as Failed, and we've raised ${r.action.ref} to fix it.`
        : `${item.title} sent. Thank you.`,
    )
  }
  void queryClient.invalidateQueries()
})

// The service worker caches the app shell so the app opens with no signal (production builds only).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register(appPath("/sw.js"), { scope: appPath("/") })
      .then(() => refreshPush())
      .catch(() => undefined)
  })
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <PropertyProvider>
        <RouterProvider router={router} />
        <Toaster />
      </PropertyProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
