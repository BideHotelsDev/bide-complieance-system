/* The published on-screen wording from Settings › Messages and wording (privacy notice, tour, empty states). */
import { useQuery } from "@tanstack/react-query"

import { api } from "@bide-comply/api-client"

export function useWording() {
  return useQuery({
    queryKey: ["wording"],
    queryFn: () => api.get<Record<string, string>>("/api/settings/wording"),
    staleTime: 5 * 60_000,
  })
}
