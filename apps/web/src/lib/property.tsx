/*
 * The property switcher: pick a property and every page follows it, so nobody filters by property on each screen
 * (design: Navigation ①). Remembered per browser; "all" means every property you can see.
 */
import * as React from "react"

import { useMe } from "./session"

type Ctx = { propertyId: string | null; setPropertyId: (id: string | null) => void }
const PropertyContext = React.createContext<Ctx>({ propertyId: null, setPropertyId: () => {} })
const KEY = "bc-property"

export function PropertyProvider({ children }: { children: React.ReactNode }) {
  const [propertyId, set] = React.useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY)
    } catch {
      return null
    }
  })
  const me = useMe()
  // Drop a remembered property that this person can no longer see.
  React.useEffect(() => {
    if (me.data && propertyId && !me.data.properties.some((p) => p.id === propertyId)) set(null)
  }, [me.data, propertyId])
  const setPropertyId = React.useCallback((id: string | null) => {
    set(id)
    try {
      if (id) localStorage.setItem(KEY, id)
      else localStorage.removeItem(KEY)
    } catch {
      /* ignore */
    }
  }, [])
  return <PropertyContext.Provider value={{ propertyId, setPropertyId }}>{children}</PropertyContext.Provider>
}

export function useProperty() {
  const ctx = React.useContext(PropertyContext)
  const me = useMe()
  const property = me.data?.properties.find((p) => p.id === ctx.propertyId) ?? null
  return { ...ctx, property }
}
