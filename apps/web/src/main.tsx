import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import * as React from "react"
import { createRoot } from "react-dom/client"

import { api, ApiError, configure } from "@bide-comply/api-client"
import { Toaster } from "@bide-comply/ui/components/toaster"
import { loadTheme, type Theme } from "@bide-comply/ui/lib/theme"

import "./index.css"
import { PropertyProvider } from "./lib/property"
import { router } from "./router"

// Theme first, so the first paint already has the published colours (CMS-13).
void loadTheme(() => api.get<Theme>("/api/theme"))

configure({
  app: "web",
  onSignedOut: (code) => {
    if (!location.pathname.startsWith("/signin")) {
      const q = new URLSearchParams({ next: location.pathname + location.search })
      if (code === "idle") q.set("reason", "idle")
      location.href = `/signin?${q}`
    }
  },
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (n, e) => !(e instanceof ApiError && [401, 403, 404].includes(e.status)) && n < 2,
    },
  },
})

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
