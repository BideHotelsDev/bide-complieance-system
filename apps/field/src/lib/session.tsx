import { useQuery } from "@tanstack/react-query"
import { ApiError } from "@bide-comply/api-client"
import * as React from "react"

import { cachedGet } from "./cache"
import type { Me } from "./types"

export function useMe() {
  return useQuery<Me, ApiError>({
    queryKey: ["me"],
    queryFn: () => cachedGet<Me>("/api/me"),
    staleTime: 60_000,
    retry: (n, e) => e.status !== 401 && n < 2,
  })
}

/* The property the person is working at. Remembered on the phone; the switcher only appears with more than one. */
const KEY = "bc-field-property"

type Ctx = { propertyId: string | null; setPropertyId: (id: string) => void }
const PropertyContext = React.createContext<Ctx>({ propertyId: null, setPropertyId: () => undefined })

export function PropertyProvider({ children }: { children: React.ReactNode }) {
  const me = useMe()
  const [saved, setSaved] = React.useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY)
    } catch {
      return null
    }
  })
  const props = me.data?.properties ?? []
  const propertyId = props.find((p) => p.id === saved)?.id ?? props[0]?.id ?? null
  const setPropertyId = React.useCallback((id: string) => {
    setSaved(id)
    try {
      localStorage.setItem(KEY, id)
    } catch {
      /* private mode */
    }
  }, [])
  return <PropertyContext.Provider value={{ propertyId, setPropertyId }}>{children}</PropertyContext.Provider>
}

export function useProperty(): Ctx {
  return React.useContext(PropertyContext)
}
