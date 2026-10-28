import { useQuery } from "@tanstack/react-query"
import { api, ApiError } from "@bide-comply/api-client"

export type Me = {
  id: string
  name: string
  first_name: string
  initials: string
  email: string | null
  title: string
  kind: "staff" | "external"
  roles: string[]
  role: string
  role_label: string
  is_admin: boolean
  spvs: string[]
  all_properties: boolean
  properties: { id: string; name: string; code: string; town: string | null; stage: string }[]
  can: Record<string, boolean>
  preferences: Record<string, unknown>
  privacy_notice_seen: boolean
  session_ends_hours: number | null
}

export function useMe() {
  return useQuery<Me, ApiError>({
    queryKey: ["me"],
    queryFn: () => api.get<Me>("/api/me"),
    staleTime: 60_000,
    retry: (n, e) => e.status !== 401 && n < 2,
  })
}

/* What each person sees in the sidebar (design: Navigation › What each person sees) */
export function navFor(me: Me) {
  const r = new Set(me.roles)
  const admin = me.is_admin
  const dutyholderOnly = r.has("dutyholder") && !admin
  const siteLeadOnly = r.has("site_lead") && !admin && !r.has("dutyholder")
  const assessorOnly = r.has("assessor") && !admin
  return {
    home: true,
    todo: !dutyholderOnly,
    properties: admin || r.has("dutyholder") || assessorOnly,
    actions: !dutyholderOnly,
    reviews: me.can.verify,
    gates: admin || assessorOnly,
    signoffs: admin || r.has("dutyholder"),
    scorecard: me.can["scorecard.view"] && !siteLeadOnly && !dutyholderOnly,
    reports: me.can["export.pack"] && (admin || assessorOnly),
    assessor: me.can["assessor.walk"],
    settings: me.can["settings.view"],
  }
}
